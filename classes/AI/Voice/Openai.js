'use strict';
/**
 * AI/Voice/Openai — OpenAI text-to-speech adapter.
 *
 * Config keys (all under AI/voice/):
 *   AI/voice/key    — OpenAI API key (Bearer token)
 *   AI/voice/voice  — Voice name (default: 'nova')
 *                     Options: alloy, echo, fable, onyx, nova, shimmer
 *   AI/voice/model  — Model (default: 'tts-1'; use 'tts-1-hd' for higher quality)
 *
 * @class AI_Voice.Openai
 * @extends AI_Voice
 */
var AI_Voice = require('../Voice');

/**
 * @constructor
 * @param {Object} [options]
 */
AI_Voice.Openai = function (options) {};
AI_Voice.Openai.prototype = Object.create(AI_Voice.prototype);
AI_Voice.Openai.prototype.constructor = AI_Voice.Openai;

/**
 * @property platform
 * @type {String}
 */
AI_Voice.Openai.prototype.platform = 'OpenAI';

/**
 * Convert text to base64-encoded MP3 via OpenAI /v1/audio/speech.
 *
 * @method speak
 * @param {String} text
 * @param {Object} [options]
 * @param {Object} [options.Q]      Server-side Q object for Config reads.
 * @param {String} [options.voice]  Voice name override.
 * @param {String} [options.model]  Model override.
 * @return {Promise<String|null>}   Base64 MP3 or null on failure.
 */
AI_Voice.Openai.prototype.speak = function (text, options) {
    var Q     = options && options.Q;
    var key   = Q && Q.Config.get(['AI', 'voice', 'key'], null);
    if (!key) return Promise.resolve(null);
    var voice = (options && options.voice)
        || (Q && Q.Config.get(['AI', 'voice', 'voice'], 'nova'));
    var model = (options && options.model)
        || (Q && Q.Config.get(['AI', 'voice', 'model'], 'tts-1'));

    return fetch('https://api.openai.com/v1/audio/speech', {
        method:  'POST',
        headers: {
            'Authorization': 'Bearer ' + key,
            'Content-Type':  'application/json'
        },
        body: JSON.stringify({ model: model, input: text, voice: voice })
    }).then(function (resp) {
        if (!resp.ok) return null;
        return resp.arrayBuffer().then(function (buf) {
            return Buffer.from(buf).toString('base64');
        });
    }).catch(function () { return null; });
};

module.exports = AI_Voice.Openai;
