'use strict';
/**
 * AI_Transcription_Openai → AI.Transcription.Openai
 * Adapter for OpenAI Whisper speech-to-text.
 * Synchronous — transcribe() resolves with the completed transcript.
 * Mirrors PHP AI_Transcription_Openai.
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

AI_Transcription.Openai = function (options) {
	this.model = Q.Config.get(['AI', 'transcription', 'models', 'openai'], 'whisper-1');
};
AI_Transcription.Openai.prototype = Object.create(AI_Transcription.prototype);
AI_Transcription.Openai.prototype.platform = 'OpenAI';
AI_Transcription.Openai._jobs = {};

AI_Transcription.Openai.prototype.transcribe = function (source, options) {
	options    = options || {};
	var apiKey = Q.Config.get(['AI', 'openAI', 'key'], null);
	if (!apiKey) return Promise.reject(new Error('AI.Transcription.Openai: missing API key (AI/openAI/key)'));
	var model  = options.model || this.model;
	var jobId  = 'openai_' + crypto.createHash('md5').update(source + Date.now()).digest('hex');

	return new Promise(function (resolve) {
		// Download audio to temp file — Whisper requires a file upload, not a URL
		var parsed  = urlMod.parse(source);
		var mod     = parsed.protocol === 'https:' ? http : htt;
		var tmpPath = path.join(os.tmpdir(), 'whisper_' + jobId + '.audio');
		var file    = fs.createWriteStream(tmpPath);

		mod.get(source, function (res) {
			res.pipe(file);
			file.on('finish', function () {
				file.close(function () {
					var boundary = '----WhisperBoundary' + Date.now();
					var CRLF     = '\r\n';
					var audio    = fs.readFileSync(tmpPath);
					var langPart = options.language
						? '--' + boundary + CRLF +
						  'Content-Disposition: form-data; name="language"' + CRLF + CRLF +
						  options.language + CRLF
						: '';
					var pre  = Buffer.from(
						'--' + boundary + CRLF +
						'Content-Disposition: form-data; name="model"' + CRLF + CRLF +
						model + CRLF +
						langPart +
						'--' + boundary + CRLF +
						'Content-Disposition: form-data; name="file"; filename="audio.mp3"' + CRLF +
						'Content-Type: audio/mpeg' + CRLF + CRLF
					);
					var post = Buffer.from(CRLF + '--' + boundary + '--' + CRLF);
					var body = Buffer.concat([pre, audio, post]);

					_post('https://api.openai.com/v1/audio/transcriptions', {
						'Authorization': 'Bearer ' + apiKey,
						'Content-Type':  'multipart/form-data; boundary=' + boundary
					}, body, (options.timeout || 300) * 1000)
					.then(function (res) {
						fs.unlink(tmpPath, function () {});
						var data; try { data = JSON.parse(res.body); } catch(e) { data = {}; }
						var result = data.text
							? { id: jobId, status: 'COMPLETED', text: data.text }
							: { id: jobId, status: 'FAILED', error: data };
						AI_Transcription.Openai._jobs[jobId] = result;
						resolve(result);
					})
					.catch(function (e) {
						fs.unlink(tmpPath, function () {});
						var result = { id: jobId, status: 'FAILED', error: e.message };
						AI_Transcription.Openai._jobs[jobId] = result;
						resolve(result);
					});
				});
			});
		}).on('error', function (e) {
			file.close(function () { fs.unlink(tmpPath, function () {}); });
			var result = { id: jobId, status: 'FAILED', error: 'fetch audio failed: ' + e.message };
			AI_Transcription.Openai._jobs[jobId] = result;
			resolve(result);
		});
	});
};

AI_Transcription.Openai.prototype.fetch = function (transcriptId, options) {
	var job = AI_Transcription.Openai._jobs[transcriptId];
	return Promise.resolve(job || { id: transcriptId, status: 'NOT_FOUND' });
};

module.exports = AI_Transcription.Openai;
