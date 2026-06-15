'use strict';
/**
 * AI/Voice/Google — Google Cloud Text-to-Speech v1 adapter.
 *
 * Config keys (all under AI/voice/):
 *   AI/voice/key       — Google Cloud API key
 *   AI/voice/language  — Language code (default: 'en-US')
 *   AI/voice/gender    — 'MALE' | 'FEMALE' | 'NEUTRAL' (default: 'NEUTRAL')
 *   AI/voice/voice     — Specific voice name override (optional)
 *                        e.g. 'en-US-Neural2-F'
 *
 * @class AI_Voice.Google
 * @extends AI_Voice
 */
var AI_Voice = require('../Voice');

/**
 * @constructor
 * @param {Object} [options]
 */
AI_Voice.Google = function (options) {};
AI_Voice.Google.prototype = Object.create(AI_Voice.prototype);
AI_Voice.Google.prototype.constructor = AI_Voice.Google;

/**
 * @property platform
 * @type {String}
 */
AI_Voice.Google.prototype.platform = 'Google';

/**
 * Convert text to base64-encoded MP3 via Google Cloud TTS v1.
 *
 * @method speak
 * @param {String} text
 * @param {Object} [options]
 * @param {Object} [options.Q]        Server-side Q object for Config reads.
 * @param {String} [options.language] Language code override.
 * @param {String} [options.gender]   'MALE' | 'FEMALE' | 'NEUTRAL' override.
 * @return {Promise<String|null>}     Base64 MP3 or null on failure.
 */
AI_Voice.Google.prototype.speak = function (text, options) {
    var Q        = options && options.Q;
    var key      = Q && Q.Config.get(['AI', 'voice', 'key'], null);
    if (!key) return Promise.resolve(null);
    var language = (options && options.language)
        || (Q && Q.Config.get(['AI', 'voice', 'language'], 'en-US'));
    var gender   = (options && options.gender)
        || (Q && Q.Config.get(['AI', 'voice', 'gender'], 'NEUTRAL'));
    var voiceName = (options && options.voice)
        || (Q && Q.Config.get(['AI', 'voice', 'voice'], null));

    var voiceSpec = { languageCode: language, ssmlGender: gender };
    if (voiceName) voiceSpec.name = voiceName;

    return fetch(
        'https://texttospeech.googleapis.com/v1/text:synthesize?key=' + key,
        {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
                input:       { text: text },
                voice:       voiceSpec,
                audioConfig: { audioEncoding: 'MP3' }
            })
        }
    ).then(function (resp) {
        if (!resp.ok) return null;
        return resp.json().then(function (data) {
            return data.audioContent || null;
        });
    }).catch(function () { return null; });
};

module.exports = AI_Voice.Google;
