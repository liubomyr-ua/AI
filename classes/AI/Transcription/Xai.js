'use strict';
/**
 * AI_Transcription_Xai → AI.Transcription.Xai
 * Adapter for xAI's Speech-to-Text API (Grok STT).
 * Named after the company (Xai) rather than the product (Grok) to match
 * the plugin's factory convention — callers select specific models via
 * options.model if xAI ships additional STT models later.
 *
 * xAI STT is synchronous over REST — transcribe() downloads the source,
 * uploads it as multipart to https://api.x.ai/v1/stt, and resolves with the
 * completed transcript. Because the call can take many seconds on long
 * audio, this is designed to be invoked from the Node side (via the
 * AI/Transcription/Xai/transcribe Q/method registration in AI.listen), not
 * from PHP directly. PHP delegates through Q_Utils::sendToNode so PHP
 * workers don't block on xAI.
 *
 * For long audio or high concurrency, prefer xAI's WebSocket streaming
 * endpoint (wss://api.x.ai/v1/stt) instead of this REST path.
 *
 * Supported options:
 *   _diarization           {object|true}  shorthand → sets diarize=true
 *   _diarization.max       {number}       forward-compat hint (speakers_expected)
 *   format                 {boolean}      Inverse Text Normalization
 *   language               {string}       ISO code; omit for auto-detect
 *   diarize                {boolean}      native xAI flag
 *   model                  {string}       override the default STT model
 *   timeout                {number}       seconds, default 300
 *
 * @module AI
 */
var Q      = require('Q');
var fs     = require('fs');
var path   = require('path');
var os     = require('os');
var http   = require('https');
var htt    = require('http');
var urlMod = require('url');
var crypto = require('crypto');
var AI_Transcription = require('AI/Transcription');
var Http   = require('AI/Http');
var _post  = Http._post;

AI_Transcription.Xai = function (options) {};
AI_Transcription.Xai.prototype = Object.create(AI_Transcription.prototype);
AI_Transcription.Xai.prototype.platform = 'xAI';
AI_Transcription.Xai._jobs = {};

function _xaiMime(filename) {
	var ext = (path.extname(filename || '') || '').replace('.', '').toLowerCase();
	var map = {
		mp3:  'audio/mpeg',
		wav:  'audio/wav',
		flac: 'audio/flac',
		ogg:  'audio/ogg',
		oga:  'audio/ogg',
		opus: 'audio/opus',
		m4a:  'audio/mp4',
		mp4:  'video/mp4',
		webm: 'video/webm',
		aac:  'audio/aac',
		amr:  'audio/amr'
	};
	return map[ext] || 'application/octet-stream';
}

AI_Transcription.Xai.prototype.transcribe = function (source, options) {
	options = options || {};
	var apiKey = Q.Config.get(['AI', 'xai', 'key'], null);
	if (!apiKey) return Promise.reject(new Error('AI.Transcription.Xai: missing API key (AI/xai/key)'));

	var jobId = 'xai_' + crypto.createHash('md5').update(source + Date.now()).digest('hex');

	// Normalize cross-provider shorthand.
	var fields = Object.assign({}, options);
	if (fields._diarization) {
		fields.diarize = true;
		if (fields._diarization.max) fields.speakers_expected = fields._diarization.max;
		delete fields._diarization;
	}
	delete fields._webhook;
	delete fields._echo;
	delete fields.callback;
	var timeoutSec = fields.timeout || 300;
	delete fields.timeout;

	var parsedSrc = urlMod.parse(source);
	var filename = path.basename(parsedSrc.pathname || '') || 'audio';
	var mime = _xaiMime(filename);

	return new Promise(function (resolve) {
		var srcMod = parsedSrc.protocol === 'https:' ? http : htt;
		var tmpPath = path.join(os.tmpdir(), 'xaistt_' + jobId + '.audio');
		var file = fs.createWriteStream(tmpPath);

		srcMod.get(source, function (res) {
			if (res.statusCode >= 400) {
				file.close(function () { fs.unlink(tmpPath, function () {}); });
				var failed = { id: jobId, status: 'FAILED', error: 'fetch audio failed: HTTP ' + res.statusCode };
				AI_Transcription.Xai._jobs[jobId] = failed;
				return resolve(failed);
			}
			res.pipe(file);
			file.on('finish', function () {
				file.close(function () {
					var boundary = '----XaiBoundary' + Date.now();
					var CRLF = '\r\n';
					var audio = fs.readFileSync(tmpPath);

					// Per xAI docs, `file` must come LAST in the multipart form.
					var parts = [];
					Object.keys(fields).forEach(function (k) {
						var v = fields[k];
						if (v === null || typeof v === 'undefined') return;
						if (typeof v === 'boolean') v = v ? 'true' : 'false';
						parts.push(Buffer.from(
							'--' + boundary + CRLF +
							'Content-Disposition: form-data; name="' + k + '"' + CRLF + CRLF +
							v + CRLF
						));
					});
					parts.push(Buffer.from(
						'--' + boundary + CRLF +
						'Content-Disposition: form-data; name="file"; filename="' + filename + '"' + CRLF +
						'Content-Type: ' + mime + CRLF + CRLF
					));
					parts.push(audio);
					parts.push(Buffer.from(CRLF + '--' + boundary + '--' + CRLF));
					var body = Buffer.concat(parts);

					_post('https://api.x.ai/v1/stt', {
						'Authorization': 'Bearer ' + apiKey,
						'Content-Type':  'multipart/form-data; boundary=' + boundary
					}, body, timeoutSec * 1000)
					.then(function (httpRes) {
						fs.unlink(tmpPath, function () {});
						var data; try { data = JSON.parse(httpRes.body); } catch(e) { data = {}; }
						var result;
						if (!data || !data.text) {
							result = { id: jobId, status: 'FAILED', error: data || httpRes.body };
						} else {
							result = { id: jobId, status: 'COMPLETED', text: data.text };
							['duration', 'language', 'words', 'segments', 'speakers'].forEach(function (k) {
								if (typeof data[k] !== 'undefined') result[k] = data[k];
							});
						}
						AI_Transcription.Xai._jobs[jobId] = result;
						resolve(result);
					})
					.catch(function (e) {
						fs.unlink(tmpPath, function () {});
						var result = { id: jobId, status: 'FAILED', error: e.message };
						AI_Transcription.Xai._jobs[jobId] = result;
						resolve(result);
					});
				});
			});
		}).on('error', function (e) {
			file.close(function () { fs.unlink(tmpPath, function () {}); });
			var result = { id: jobId, status: 'FAILED', error: 'fetch audio failed: ' + e.message };
			AI_Transcription.Xai._jobs[jobId] = result;
			resolve(result);
		});
	});
};

AI_Transcription.Xai.prototype.fetch = function (transcriptId, options) {
	var job = AI_Transcription.Xai._jobs[transcriptId];
	return Promise.resolve(job || { id: transcriptId, status: 'NOT_FOUND' });
};

module.exports = AI_Transcription.Xai;
