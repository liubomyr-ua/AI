"use strict";

/**
 * @module AI
 */

var AI_Voice = require('./Voice');

/**
 * Pre-generate a TTS audio file alongside a transcript cue.
 * Saved as `cue-{ordinal}.mp3` next to the session's transcript.vtt
 * for replay. Uses the Voice provider at AI/voice/provider.
 *
 * Fire-and-forget — errors are logged, never thrown.
 *
 * @class AI.CueAudio
 * @static
 */
function CueAudio() {}

/**
 * Generate a cue audio file for an ordinal.
 * @method generate
 * @static
 * @param {Object} session
 * @param {Object} entry   { text, speaker, relSec }
 * @param {Number} ordinal
 * @param {Object} Q
 */
CueAudio.generate = async function (session, entry, ordinal, Q) {
    try {
        var provider = Q.Config && Q.Config.get(['AI', 'voice', 'provider'], null);
        if (!provider) return;
        var voice = AI_Voice.create(provider);
        if (!voice) return;
        var audioB64 = await voice.speak(entry.text, { Q: Q });
        if (!audioB64) return;

        var fs   = require('fs');
        var path = require('path');
        var dir  = path.dirname(session.transcriptFile);
        var file = path.join(dir, 'cue-' + ordinal + '.mp3');
        var buf  = Buffer.from(audioB64, 'base64');

        fs.writeFile(file, buf, function (err) {
            if (err) Q.log && Q.log('AI: cue audio write error', err.message);
        });
    } catch (e) {
        Q.log && Q.log('AI: CueAudio.generate error', e.message);
    }
};

module.exports = CueAudio;
