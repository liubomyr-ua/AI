'use strict';
/**
 * AI/classes/AI/TranscriptBuffer.js
 *
 * Turns a growing real-time transcript into the "real-time transcript" part
 * of the three-part prompt built by AI/classes/AI/Prompt.js:
 *
 *   1. Fixed system prompt   (Prompt._buildStaticPrefix — cached, unchanging)
 *   2. Older context         (this.summary, rendered by Prompt.renderOlderContext)
 *   3. Real-time transcript  (this.chunks — the sliding window built here)
 *
 * CHUNKING (rule #1)
 * ───────────────────
 * New speech text accumulates in `_pending`. Once >= chunkSize (200) new
 * characters have arrived, flushPendingChunk() finalizes them into one
 * chunk. Each call's real-time transcript window is the concatenation of
 * the last minChunksInWindow..maxChunksInWindow chunks (oldest first), so
 * consecutive calls always overlap — the model sees some text it already
 * saw last turn plus what's new, instead of a disjoint 200-char sliver.
 *
 * Chunks older than maxChunksInWindow don't just vanish: by the time they
 * age out, they've already been seen by the model at least once (they
 * entered the window newest-first and only fall off after further chunks
 * push them past the cap), and setSummary() is called with the model's
 * updated contextSummary right after — so their content lives on in the
 * rolling summary instead of the raw window.
 *
 * TOKEN BUDGET (rule #2)
 * ────────────────────────
 * getRealtimeWindow() estimates tokens (via Prompt.estimateTokens, backed by
 * tiktoken) for the fixed prefix + older-context text + per-call instructions,
 * then caps the real-time window to whatever's left of maxInputTokens (and to
 * realtimeFraction of it), trimming the oldest chunks first. It will never
 * trim below minChunksInWindow chunks — losing the overlap between calls
 * defeats the point more than a bit of budget overrun does.
 *
 * One instance lives per transcription session, at
 * Streams.Transcript.Session#transcriptContext (lazily created by Pipeline).
 *
 * @module AI
 * @class TranscriptBuffer
 */

var Q      = require('Q');
var Prompt = require('./Prompt');

var DEFAULTS = {
    chunkSize:         200,   // chars of new speech that triggers a send + a new chunk
    minChunksInWindow: 2,     // never trim below this — guarantees turn-to-turn overlap
    maxChunksInWindow: 4,     // chunks kept in the window before folding into the summary
    maxInputTokens:    8000,  // total prompt token budget (prefix + older context + window);
                               // the static prefix alone runs ~5k tokens (full schema listing),
                               // see Prompt.getStaticPrefixTokenCount()
    realtimeFraction:  0.35   // real-time transcript's target share of maxInputTokens
};

function _config(key, fallback) {
    return Q.Config.get(['AI', 'transcriptBuffer', key], fallback);
}

function TranscriptBuffer(options) {
    options = options || {};
    this.chunkSize         = options.chunkSize         || _config('chunkSize',         DEFAULTS.chunkSize);
    this.minChunksInWindow = options.minChunksInWindow || _config('minChunksInWindow', DEFAULTS.minChunksInWindow);
    this.maxChunksInWindow = options.maxChunksInWindow || _config('maxChunksInWindow', DEFAULTS.maxChunksInWindow);
    this.maxInputTokens    = options.maxInputTokens    || _config('maxInputTokens',    DEFAULTS.maxInputTokens);
    this.realtimeFraction  = options.realtimeFraction  || _config('realtimeFraction', DEFAULTS.realtimeFraction);

    this._pending = '';   // raw text accumulated since the last finalized chunk
    this.chunks   = [];   // finalized chunks, oldest first, still in/entering the window
    this.summary  = null; // last contextSummary object the AI returned, or null
}

/**
 * Append newly-arrived transcript text (already stripped of wake-word
 * markers etc — see Pipeline.run()) to the pending accumulator.
 * @method addText
 */
TranscriptBuffer.prototype.addText = function (text) {
    if (text) this._pending += text;
};

/**
 * True once enough new text has accumulated since the last chunk to justify
 * sending a call — the flat 200-char threshold from rule #1. (Not a growing
 * threshold — every send needs exactly this many *new* characters.)
 * @method hasEnoughNewText
 */
TranscriptBuffer.prototype.hasEnoughNewText = function () {
    return this._pending.length >= this.chunkSize;
};

/** Characters accumulated but not yet finalized into a chunk. */
TranscriptBuffer.prototype.pendingLength = function () {
    return this._pending.length;
};

/**
 * Finalize the accumulated pending text into one chunk (any pending text —
 * we never split a burst mid-chunk, so a chunk may run past chunkSize when
 * a lot of speech arrived between two Pipeline.run() calls). No-op if
 * hasEnoughNewText() hasn't been checked/true; call sites should guard with
 * hasEnoughNewText() first so a chunk isn't cut mid-thought at a tiny size.
 * @method flushPendingChunk
 */
TranscriptBuffer.prototype.flushPendingChunk = function () {
    if (!this._pending) return;
    this.chunks.push({ text: this._pending, createdAt: Date.now() });
    this._pending = '';
};

/**
 * Build the real-time transcript text for the next call: the last N chunks,
 * oldest first, trimmed to fit the token budget.
 *
 * @method getRealtimeWindow
 * @param {Object} [contextSummary] Defaults to this.getSummary() — pass
 *   explicitly only if budgeting against a summary not yet stored.
 * @param {String} [instructionsBaseText] The rest of the per-call instructions
 *   block (role/stream/contextHint lines) so the budget accounts for it too.
 * @return {String}
 */
TranscriptBuffer.prototype.getRealtimeWindow = function (contextSummary, instructionsBaseText) {
    if (contextSummary === undefined) contextSummary = this.summary;

    // Chunks beyond the cap have already been folded into the summary by
    // setSummary() after the previous call; this is just a defensive clamp.
    if (this.chunks.length > this.maxChunksInWindow) {
        this.chunks = this.chunks.slice(this.chunks.length - this.maxChunksInWindow);
    }

    var olderContextText = Prompt.renderOlderContext(contextSummary);
    var systemTokens       = Prompt.getStaticPrefixTokenCount();
    var olderContextTokens = Prompt.estimateTokens(olderContextText);
    var baseTokens          = Prompt.estimateTokens(instructionsBaseText || '');

    var available = this.maxInputTokens - systemTokens - olderContextTokens - baseTokens;
    var byFraction = Math.floor(this.maxInputTokens * this.realtimeFraction);
    var budget = Math.max(0, Math.min(available, byFraction));

    var window = this.chunks.slice();
    while (window.length > this.minChunksInWindow &&
           Prompt.estimateTokens(_joinChunks(window)) > budget) {
        window.shift();
    }

    this._lastWindowSize = window.length;
    return _joinChunks(window);
};

function _joinChunks(chunks) {
    return chunks.map(function (c) { return c.text; }).join('');
}

/**
 * The rolling summary as of the last completed call, or null before the
 * first response of a session.
 * @method getSummary
 */
TranscriptBuffer.prototype.getSummary = function () {
    return this.summary;
};

/**
 * Store the contextSummary the AI returned for the call that just used
 * getRealtimeWindow(), and drop chunks beyond maxChunksInWindow now that
 * their content is captured in the new summary.
 * @method setSummary
 */
TranscriptBuffer.prototype.setSummary = function (summary) {
    if (!summary || typeof summary !== 'object') return;
    this.summary = summary;
    if (this.chunks.length > this.maxChunksInWindow) {
        this.chunks = this.chunks.slice(this.chunks.length - this.maxChunksInWindow);
    }
};

module.exports = TranscriptBuffer;
