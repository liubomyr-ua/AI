'use strict';
/**
 * AI/Voice — provider-agnostic text-to-speech layer.
 *
 * Mirrors AI/Transcription in structure and naming conventions.
 * Direction: text → speech (TTS). The inverse is AI/Transcription (STT).
 *
 * Adapters (each in AI/classes/AI/Voice/{Adapter}.js):
 *   Elevenlabs  — ElevenLabs v1 text-to-speech
 *   Openai      — OpenAI TTS (tts-1, tts-1-hd)
 *   Google      — Google Cloud TTS v1
 *
 * Usage:
 *   var AI_Voice = require('AI/Voice');
 *   var voice = AI_Voice.create(
 *       Q.Config.get(['AI', 'voice', 'provider'], 'openai')
 *   );
 *   var audioB64 = await voice.speak('Hello world', { Q });
 *
 * All adapters return a base64-encoded MP3 string, or null on failure.
 * This is JSON-serializable and matches the _generateCueAudio contract
 * in AI/handlers/socket.js.
 *
 * Config keys (read by each adapter):
 *   AI/voice/provider  — 'elevenlabs' | 'openai' | 'google' | null (disables)
 *   AI/voice/key       — API key for the configured provider
 *   AI/voice/voice     — Voice name or ID (provider-specific)
 *   AI/voice/model     — Model override (provider-specific)
 *   AI/voice/language  — Language code e.g. 'en-US' (Google)
 *   AI/voice/gender    — 'MALE' | 'FEMALE' | 'NEUTRAL' (Google)
 *
 * @module AI
 */

// ── AI_Voice base ─────────────────────────────────────────────────────────────

/**
 * Base class for all text-to-speech adapters.
 * Do not instantiate directly — use AI_Voice.create().
 * @class AI_Voice
 * @constructor
 */
function AI_Voice() {}
module.exports = AI_Voice;

/**
 * Factory — mirrors AI_Transcription.create().
 * Returns an adapter instance for the given provider name,
 * or null if the name is unrecognised.
 *
 * @method create
 * @static
 * @param {String|Object} adapter  Provider name ('elevenlabs', 'openai', 'google')
 *   or an existing adapter instance (passed through unchanged).
 * @param {Object} [options]  Passed to the adapter constructor.
 * @return {AI_Voice|null}
 */
AI_Voice.create = function (adapter, options) {
    if (!adapter) return null;
    if (typeof adapter === 'object') return adapter;
    // Normalise: 'eleven-labs' → 'Elevenlabs', 'openai' → 'Openai'
    var s      = adapter.replace(/[^a-z0-9]+/gi, ' ').trim();
    var suffix = s.replace(/\s+(.)/g, function (_, c) { return c.toUpperCase(); });
    suffix     = suffix.charAt(0).toUpperCase() + suffix.slice(1);
    var cls    = AI_Voice[suffix];
    if (cls) return new cls(options);
    return null;
};

/**
 * Convert text to a base64-encoded MP3 audio buffer.
 * Adapters override this method.
 *
 * @method speak
 * @param {String} text          The text to synthesize.
 * @param {Object} [options]
 * @param {Object} [options.Q]         Server-side Q object (for Config reads).
 * @param {String} [options.voice]     Voice name or ID override.
 * @param {String} [options.language]  Language code e.g. 'en-US'.
 * @param {Number} [options.rate]      Speech rate multiplier (adapter-dependent).
 * @param {String} [options.gender]    'male' | 'female' | 'neutral'.
 * @return {Promise<String|null>}  Base64-encoded MP3, or null if not configured
 *   or if the provider call fails.
 */
AI_Voice.prototype.speak = function (text, options) {
    return Promise.resolve(null);
};

/**
 * The provider platform name. Set on each adapter's prototype.
 * @property platform
 * @type {String|null}
 */
AI_Voice.prototype.platform = null;

// ── Auto-register adapters ────────────────────────────────────────────────────
// Each adapter file attaches itself to AI_Voice (e.g. AI_Voice.Elevenlabs = ...)
// so AI_Voice.create('elevenlabs') resolves immediately after this module loads.
require('./Voice/Elevenlabs');
require('./Voice/Openai');
require('./Voice/Google');
