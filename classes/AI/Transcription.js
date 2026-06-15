'use strict';
/**
 * AI/Transcription — provider-agnostic real-time speech-to-text layer.
 *
 * This file covers the SERVER-SIDE streaming interface used by socket.js
 * when the host has an AI transcription provider configured.
 * Direction: speech → text (STT). The inverse is AI/Voice (TTS).
 *
 * This is distinct from the async-batch transcription adapters
 * (AI/Transcription/Assemblyai, Openai-Whisper, Aws) which live in your
 * main codebase and handle file-URL submissions with polling/webhook.
 * Those are accessed via Protocol.Transcription in Safebox.
 *
 * Streaming adapters (each in AI/classes/AI/Transcription/{Name}Stream.js):
 *   DeepgramStream    — Deepgram wss://api.deepgram.com/v1/listen
 *   AssemblyaiStream  — AssemblyAI wss://api.assemblyai.com/v2/realtime/ws
 *
 * Usage in socket.js:
 *   var AI_Transcription = require('AI/Transcription');
 *   var adapter = AI_Transcription.create(
 *       Q.Config.get(['AI', 'transcription', 'provider'], 'deepgram')
 *   );
 *   adapter.open(session, {
 *       onUtterance: function(chunk) { ... },
 *       onError:     function(err)   { ... }
 *   });
 *   adapter.send(pcmBuffer);
 *   adapter.close();
 *
 * Utterance chunk shape (passed to onUtterance):
 *   { transcript, isFinal, confidence, speaker }
 *   isFinal:false — interim result for live caption display
 *   isFinal:true  — final result, fed into _onTranscript pipeline
 *
 * Config keys:
 *   AI/transcription/provider  — 'deepgram' | 'assemblyai' (default: 'deepgram')
 *   AI/transcription/deepgram/key
 *   AI/transcription/assemblyai/key
 *
 * @module AI
 */

// ── AI_Transcription streaming base ──────────────────────────────────────────

/**
 * Base class for all real-time streaming STT adapters.
 * Do not instantiate directly — use AI_Transcription.create().
 * @class AI_Transcription
 * @constructor
 */
function AI_Transcription() {}
module.exports = AI_Transcription;

/**
 * Factory. Returns a streaming adapter instance or null.
 * Naming convention matches AI_Voice.create():
 *   'deepgram'    → AI_Transcription.DeepgramStream
 *   'assemblyai'  → AI_Transcription.AssemblyaiStream
 *
 * @method create
 * @static
 * @param {String|Object} adapter  Provider name or existing instance.
 * @param {Object} [options]
 * @return {AI_Transcription|null}
 */
AI_Transcription.create = function (adapter, options) {
    if (!adapter) return null;
    if (typeof adapter === 'object') return adapter;
    // 'deepgram' → 'DeepgramStream', 'assemblyai' → 'AssemblyaiStream'
    // Append 'Stream' suffix to distinguish from async-batch adapters.
    var s      = adapter.replace(/[^a-z0-9]+/gi, ' ').trim();
    var suffix = s.replace(/\s+(.)/g, function (_, c) { return c.toUpperCase(); });
    suffix     = suffix.charAt(0).toUpperCase() + suffix.slice(1) + 'Stream';
    var cls    = AI_Transcription[suffix];
    if (cls) return new cls(options);
    return null;
};

/**
 * Open a streaming transcription session.
 * Called when the host starts the AI pipeline (AI/transcription/session/start).
 *
 * @method open
 * @param {Object} session  The session object from socket.js.
 *   session.lang, session.sampleRate, session.userId are read.
 * @param {Object} options
 * @param {Function} options.onUtterance  Called with each transcript chunk.
 *   Chunk shape: { transcript, isFinal, confidence, speaker }
 * @param {Function} [options.onError]    Called with Error on connection failure.
 * @param {Object}   options.Q            Server-side Q object for Config.
 */
AI_Transcription.prototype.open = function (session, options) {};

/**
 * Send a PCM audio buffer to the provider.
 * Called for each AI/transcription/session/chunk event.
 *
 * @method send
 * @param {Buffer|ArrayBuffer} pcmBuffer  Int16 linear PCM audio data.
 */
AI_Transcription.prototype.send = function (pcmBuffer) {};

/**
 * Close the streaming session.
 * Called on AI/transcription/session/stop, AI/transcription/session/abort,
 * or socket disconnect.
 *
 * @method close
 */
AI_Transcription.prototype.close = function () {};

/**
 * @property platform
 * @type {String|null}
 */
AI_Transcription.prototype.platform = null;

// ── Auto-register streaming adapters ─────────────────────────────────────────
require('./Transcription/DeepgramStream');
require('./Transcription/AssemblyaiStream');
