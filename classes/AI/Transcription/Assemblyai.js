'use strict';
/**
 * AI_Transcription_Assemblyai → AI.Transcription.Assemblyai
 * Async adapter — transcribe() returns {id, status:'queued'}; caller polls
 * with poll() or supplies options.webhook for push notification.
 * Mirrors PHP AI_Transcription_Assemblyai.
 *
 * @module AI
 */
var Q = require('Q');
var AI_Transcription = require('AI/Transcription');
var Http  = require('AI/Http');
var _post = Http._post;
var _get  = Http._get;

AI_Transcription.Assemblyai = function (options) {};
AI_Transcription.Assemblyai.prototype = Object.create(AI_Transcription.prototype);
AI_Transcription.Assemblyai.prototype.platform = 'AssemblyAI';

AI_Transcription.Assemblyai.prototype.transcribe = function (source, options) {
	options = options || {};
	var apiKey = Q.Config.get(['AI', 'assemblyAI', 'key'], null);
	if (!apiKey) return Promise.reject(new Error('AI.Transcription.Assemblyai: missing API key (AI/assemblyAI/key)'));

	var payload = Object.assign({ audio_url: source }, options);

	// Diarization shorthand: { _diarization: { max: 3 } }
	if (payload._diarization) {
		payload.speaker_labels = true;
		if (payload._diarization.max) payload.speakers_expected = payload._diarization.max;
		delete payload._diarization;
	}

	// Webhook URL — if provided, pass through to AssemblyAI directly.
	// NOTE: When using Protocol.Transcription with spec.webhook=true, PHP handles
	// submission (Safebox/transcription POST handler) so that Users::secretToken()
	// is used correctly. This code path is for direct adapter calls only.
	if (payload.webhook || payload._webhook) {
		payload.webhook_url = payload.webhook || payload._webhook;
		delete payload.webhook;
		delete payload._webhook;
	}
	delete payload.callback;

	return _post('https://api.assemblyai.com/v2/transcript', {
		'Content-Type':  'application/json',
		'Authorization': apiKey
	}, JSON.stringify(payload), 30000)
	.then(function (res) {
		try { return JSON.parse(res.body); }
		catch(e) { throw new Error('AI.Transcription.Assemblyai: non-JSON response'); }
	});
};

AI_Transcription.Assemblyai.prototype.fetch = function (transcriptId, options) {
	var apiKey = Q.Config.get(['AI', 'assemblyAI', 'key'], null);
	if (!apiKey) return Promise.reject(new Error('AI.Transcription.Assemblyai: missing API key'));

	return _get(
		'https://api.assemblyai.com/v2/transcript/' + encodeURIComponent(transcriptId),
		{ 'Authorization': apiKey },
		30000
	).then(function (res) {
		try { return JSON.parse(res.body); }
		catch(e) { throw new Error('AI.Transcription.Assemblyai: non-JSON response'); }
	});
};

module.exports = AI_Transcription.Assemblyai;
