'use strict';
/**
 * AI/classes/AI/WakeMarkers.js
 *
 * Small, dependency-free helper for the __WAKESTART__ / __WAKEEND__ inline
 * markers Pipeline.js writes into a transcript entry's .text to annotate
 * where a "Hey Safebots" wake-word request lives (see
 * extractCommandAfterWakeWord and isCompletionMarker in Pipeline.js).
 *
 * @module AI
 * @class WakeMarkers
 * @static
 */

var START = '__WAKESTART__';
var END   = '__WAKEEND__';

/**
 * Remove wake-word request span(s) out of transcript text before it's
 * folded into the general (non-wake) rolling-summary buffer.
 *
 * A single transcript entry can carry only __WAKESTART__, only __WAKEEND__,
 * or both — Pipeline concatenates entries in arrival order before calling
 * this, so a start and its matching end are always found in that order in
 * the combined string even when they land in different entries.
 *
 * A wake sequence that times out without a completion phrase (see the 3s
 * _wakeInterval fallback in Pipeline's constructor) never gets a
 * __WAKEEND__ at all — `(?:__WAKEEND__|$)` falls through to end-of-string
 * for that case, so the whole unterminated command still gets removed
 * rather than just the prefix up to __WAKESTART__.
 *
 * @method stripSpans
 * @static
 * @param {String} text  Concatenation of one or more transcript entries' text
 * @return {String}
 */
function stripSpans(text) {
    if (!text) return text;
    return text.replace(/__WAKESTART__[\s\S]*?(?:__WAKEEND__|$)/g, '');
}

module.exports = { START: START, END: END, stripSpans: stripSpans };
