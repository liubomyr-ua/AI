'use strict';
/**
 * AI/Transcription — provider-agnostic transcription layer.
 *
 * This file holds:
 *   - AI_Transcription class (base + factory)
 *   - AI_Transcription.prototype.poll() (retry helper for async adapters)
 *   - require hooks that load each adapter file so
 *     AI_Transcription.create('openai'|'xai'|'assemblyai'|'aws') works
 *     without the caller needing to preload anything.
 *
 * Mirrors the PHP filesystem layout:
 *   classes/AI/Transcription.php             (base + factory)
 *   classes/AI/Transcription/<Adapter>.php   (one per provider)
 *
 * Adapters:
 *   Openai      (sync, Whisper)
 *   Xai         (sync, Grok STT)
 *   Assemblyai  (async, webhook or poll)
 *   Aws         (async, poll)
 *
 * ASYNC SEMANTICS
 * ---------------
 * Openai (Whisper) and Xai (Grok STT) are synchronous — transcribe() resolves
 * with the full text (and, for Xai, per-word timestamps + speaker diarization).
 *
 * AssemblyAI and AWS are async — transcribe() resolves with {id, status:'PROCESSING'}.
 * Callers have two options:
 *
 *   Option A — Poll (simple, works for short audio):
 *     var job = await Transcription.transcribe(url, opts);
 *     var result = await Transcription.poll(job.id, opts);  // retries with sleep
 *
 *   Option B — Webhook (non-blocking, long audio):
 *     Pass opts.webhook = '<baseUrl>/Safebox/transcription/webhook'
 *     The provider POSTs back when done; Safebox updates the stream.
 *
 * @module AI
 */

var Q = require('Q');

// ── AI.Transcription base ─────────────────────────────────────────────────────

function AI_Transcription() {}
module.exports = AI_Transcription;

/**
 * Factory — mirrors PHP AI_Transcription::create().
 */
AI_Transcription.create = function (adapter, options) {
	if (!adapter) return null;
	if (typeof adapter === 'object') return adapter;
	var s = adapter.replace(/[^a-z0-9]+/gi, ' ').trim();
	// special-case 'assemblyai' → 'Assemblyai' not 'AssemblyAi'
	var suffix = s.replace(/\s+(.)/g, function (_, c) { return c.toUpperCase(); });
	suffix = suffix.charAt(0).toUpperCase() + suffix.slice(1);
	var cls = AI_Transcription[suffix];
	if (cls) return new cls(options);
	return null;
};

AI_Transcription.prototype.transcribe = function (source, options) {
	return Promise.resolve({ id: null, status: 'COMPLETED', text: '' });
};
AI_Transcription.prototype.fetch = function (transcriptId, options) {
	return Promise.resolve({ id: transcriptId, status: 'NOT_FOUND' });
};

/**
 * poll() — convenience wrapper for async adapters.
 * Retries fetch() with exponential backoff until COMPLETED or FAILED.
 *
 * @param {string} transcriptId
 * @param {object} opts
 *   maxAttempts {number}  default 20
 *   intervalMs  {number}  initial poll interval ms, default 3000
 *   maxInterval {number}  max interval ms, default 15000
 * @return {Promise<{id, status, text?, words?, error?}>}
 */
AI_Transcription.prototype.poll = function (transcriptId, opts) {
	var self        = this;
	opts            = opts || {};
	var maxAttempts = opts.maxAttempts || 20;
	var interval    = opts.intervalMs  || 3000;
	var maxInterval = opts.maxInterval || 15000;
	var attempts    = 0;

	function _sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

	function attempt() {
		return self.fetch(transcriptId).then(function (result) {
			if (result.status === 'COMPLETED' || result.status === 'FAILED') {
				return result;
			}
			attempts++;
			if (attempts >= maxAttempts) {
				return { id: transcriptId, status: 'FAILED', error: 'poll timeout after ' + attempts + ' attempts' };
			}
			interval = Math.min(interval * 1.5, maxInterval);
			return _sleep(interval).then(attempt);
		});
	}
	return attempt();
};

AI_Transcription.prototype.platform = null;

// ── Auto-register all adapter files ───────────────────────────────────────────
require('AI/Transcription/Openai');
require('AI/Transcription/Assemblyai');
require('AI/Transcription/Aws');
require('AI/Transcription/Xai');
