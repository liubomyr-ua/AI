'use strict';
/**
 * AI/classes/AI/TranscriptFold.js
 *
 * Pulls the newly-finalized text out of a session's transcriptBuffer /
 * transcriptBufferMap and removes it from both, so a later call can never
 * re-fold the same text in again (see Pipeline.run()'s "regular buffer"
 * handling, and WakeMarkers for the companion wake-span stripping applied
 * to the text this returns).
 *
 * Streams.Transcript.process fires on every WebSpeech result — interim AND
 * final — reusing the SAME entry object (keyed by latestFinalAt) while its
 * .text keeps growing as more speech is recognized. An entry is safe to
 * consume exactly once it's final: a given latestFinalAt key only ever
 * carries one isFinal:true update (the browser mints a new key right after
 * sending it — see Streams.Transcript.procesTranscript client-side), so
 * that's the one moment an entry's text is settled and won't change under
 * us. Folding+removing anything earlier is what caused the duplication bug:
 * entries used to linger in transcriptBuffer indefinitely and get
 * re-concatenated into the AI context on every subsequent call, including
 * the many interim calls that share one entry while its text grows.
 *
 * @module AI
 * @class TranscriptFold
 * @static
 */

/**
 * Remove every finalized entry from `transcriptBuffer` / `transcriptBufferMap`
 * and return their text concatenated in arrival order. Entries still growing
 * (isFinal !== true) are left in place untouched for a later call.
 *
 * @method foldFinalized
 * @static
 * @param {Array} transcriptBuffer     session.transcriptBuffer — mutated in place
 * @param {Map}   transcriptBufferMap  session.transcriptBufferMap — mutated in place
 * @return {Object} { text, hasWakeMarkers, consumedCount }
 *   text            Concatenation of the consumed entries' .text, oldest first.
 *   hasWakeMarkers  True if any consumed entry carries __WAKESTART__/__WAKEEND__
 *                   markers — the caller should run WakeMarkers.stripSpans(text).
 *   consumedCount   Number of entries removed.
 */
function foldFinalized(transcriptBuffer, transcriptBufferMap) {
    var text = '';
    var hasWakeMarkers = false;
    var consumed = [];

    for (var i = 0; i < transcriptBuffer.length; i++) {
        var entry = transcriptBuffer[i];
        if (!entry.isFinal) continue; // still growing — leave for a later call
        text += entry.text;
        if (entry.isWakeUp) hasWakeMarkers = true;
        consumed.push(entry);
    }

    consumed.forEach(function (entry) {
        var idx = transcriptBuffer.indexOf(entry);
        if (idx !== -1) transcriptBuffer.splice(idx, 1);
        transcriptBufferMap.delete(entry.latestFinalAt);
    });

    return { text: text, hasWakeMarkers: hasWakeMarkers, consumedCount: consumed.length };
}

module.exports = { foldFinalized: foldFinalized };
