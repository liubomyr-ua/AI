'use strict';
/**
 * AI/Voice/Elevenlabs — ElevenLabs text-to-speech adapter.
 *
 * Config keys (all under AI/voice/):
 *   AI/voice/key      — ElevenLabs API key (xi-api-key header)
 *   AI/voice/voice    — Voice ID (default: 'pNInz6obpgDQGcFmaJgB')
 *   AI/voice/model    — Model ID (default: 'eleven_monolingual_v1')
 *
 * @class AI_Voice.Elevenlabs
 * @extends AI_Voice
 */
var AI_Voice = require('../Voice');

/**
 * @constructor
 * @param {Object} [options]
 */
AI_Voice.Elevenlabs = function (options) {};
AI_Voice.Elevenlabs.prototype = Object.create(AI_Voice.prototype);
AI_Voice.Elevenlabs.prototype.constructor = AI_Voice.Elevenlabs;

/**
 * @property platform
 * @type {String}
 */
AI_Voice.Elevenlabs.prototype.platform = 'ElevenLabs';

/**
 * Convert text to base64-encoded MP3 via ElevenLabs v1 API.
 *
 * @method speak
 * @param {String} text
 * @param {Object} [options]
 * @param {Object} [options.Q]      Server-side Q object for Config reads.
 * @param {String} [options.voice]  Voice ID override.
 * @param {String} [options.model]  Model ID override.
 * @return {Promise<String|null>}   Base64 MP3 or null on failure.
 */
AI_Voice.Elevenlabs.prototype.speak = function (text, options) {
    var Q       = options && options.Q;
    var key     = Q && Q.Config.get(['AI', 'voice', 'key'], null);
    if (!key) return Promise.resolve(null);
    var voiceId = (options && options.voice)
        || (Q && Q.Config.get(['AI', 'voice', 'voice'], 'pNInz6obpgDQGcFmaJgB'));
    var model   = (options && options.model)
        || (Q && Q.Config.get(['AI', 'voice', 'model'], 'eleven_monolingual_v1'));

    return fetch(
        'https://api.elevenlabs.io/v1/text-to-speech/' + voiceId,
        {
            method:  'POST',
            headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
            body:    JSON.stringify({
                text:           text,
                model_id:       model,
                voice_settings: { stability: 0.5, similarity_boost: 0.75 }
            })
        }
    ).then(function (resp) {
        if (!resp.ok) return null;
        return resp.arrayBuffer().then(function (buf) {
            return Buffer.from(buf).toString('base64');
        });
    }).catch(function () { return null; });
};

module.exports = AI_Voice.Elevenlabs;
