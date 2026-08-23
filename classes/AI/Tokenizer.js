'use strict';
/**
 * AI/classes/AI/Tokenizer.js
 *
 * Local, fast token estimation used to fit a prompt into a token budget
 * *before* making a network request (rule #2 of the transcript pipeline —
 * see AI/classes/AI/TranscriptBuffer.js). Uses tiktoken's cl100k_base
 * encoding as a cross-provider approximation: we don't need an exact count
 * for any one vendor's tokenizer, just a stable, cheap estimate that scales
 * the same way real prompts do.
 *
 * @module AI
 * @class Tokenizer
 * @static
 */

var _encoding;
var _triedLoad = false;

function _encoder() {
    if (_triedLoad) return _encoding;
    _triedLoad = true;
    try {
        var tiktoken = require('tiktoken');
        _encoding = tiktoken.get_encoding('cl100k_base');
    } catch (e) {
        _encoding = null; // tiktoken not installed / failed to load native wasm
    }
    return _encoding;
}

/**
 * Estimate the number of tokens in a string.
 * Falls back to a ~4-chars-per-token heuristic if tiktoken is unavailable.
 *
 * @method estimateTokens
 * @static
 * @param {String} text
 * @return {Number}
 */
function estimateTokens(text) {
    if (!text) return 0;
    var enc = _encoder();
    if (enc) {
        try {
            return enc.encode(String(text)).length;
        } catch (e) {
            // fall through to heuristic
        }
    }
    return Math.ceil(String(text).length / 4);
}

module.exports = {
    estimateTokens: estimateTokens
};
