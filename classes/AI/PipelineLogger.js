'use strict';
/**
 * AI/classes/AI/PipelineLogger.js
 *
 * Structured, append-only log of the full pipeline process for one
 * transcription session: every call to the AI (what was sent — the
 * real-time transcript window + per-call instructions, including the
 * OLDER CONTEXT rolling summary — and what came back: raw model output,
 * usage, citations, the parsed/post-processed result, or an error) plus
 * wake-word lifecycle events. One JSON object per line (JSONL), one file
 * per session, so a whole show can be replayed call-by-call with
 * `tail -f` / `jq`.
 *
 * Writes are fire-and-forget and never throw into the caller — logging
 * must never be able to break the pipeline it's observing.
 *
 * @module AI
 * @class PipelineLogger
 */

var appendFile = require('fs/promises').appendFile;
var mkdir      = require('fs/promises').mkdir;
var dirname    = require('path').dirname;
var Q          = require('Q');

/**
 * @constructor
 * @param {Object} session  The transcription session (userId, sessionStartMs).
 */
function PipelineLogger(session) {
    this.session     = session;
    this._filePath   = undefined; // undefined = not yet resolved, null = unavailable
    this._writeQueue = Promise.resolve(); // serializes appends so concurrent
                                           // logCall()/logWakeEvent() calls
                                           // can't interleave or reorder lines
}

/**
 * One file per session: <FILES_DIR>/uploads/PipelineTest/<userId>_<sessionStartMs>.jsonl
 * @method filePath
 * @return {String|null}
 */
PipelineLogger.prototype.filePath = function () {
    if (this._filePath !== undefined) return this._filePath;
    var dir = Q.app && Q.app.FILES_DIR ? Q.app.FILES_DIR + '/uploads/PipelineTest' : null;
    this._filePath = dir
        ? dir + '/' + this.session.userId + '_' + this.session.sessionStartMs + '.jsonl'
        : null;
    return this._filePath;
};

/**
 * Appends are chained onto _writeQueue rather than fired independently —
 * two unawaited appendFile() calls can otherwise complete out of order and
 * interleave or reorder lines in the log.
 * @private
 */
PipelineLogger.prototype._write = function (event) {
    var filePath = this.filePath();
    if (!filePath) return;
    var line;
    try {
        line = JSON.stringify(Object.assign({ ts: new Date().toISOString() }, event)) + '\n';
    } catch (e) {
        return; // unserializable event (circular refs etc.) — drop rather than crash
    }
    this._writeQueue = this._writeQueue
        .then(function () { return mkdir(dirname(filePath), { recursive: true }); })
        .then(function () { return appendFile(filePath, line, 'utf8'); })
        .catch(function (e) { console.error('PipelineLogger: write failed:', e.message); });
};

/**
 * Wake-word lifecycle event (listening started, pending command, ended).
 * @method logWakeEvent
 * @param {String} type       e.g. 'STARTED_LISTENING', 'PENDING_LISTENING', 'ENDED_LISTENING'
 * @param {String} transcript
 */
PipelineLogger.prototype.logWakeEvent = function (type, transcript) {
    this._write({ type: type, transcript: transcript });
};

/**
 * One full round-trip to the AI: the request that was sent and everything
 * that came back. Call once per Pipeline.run() invocation that reaches the
 * LLM stage, whatever the outcome (success, "none", parse failure, or a
 * thrown error) — fields not available for a given outcome are just null.
 *
 * @method logCall
 * @param {Object} fields
 *   @param {String} fields.type                'REGULAR_BUFFER' | 'SAFEBOT_REQUEST'
 *   @param {String} fields.text                Real-time transcript window / command sent as the user message
 *   @param {String} fields.instructions        Per-call instructions block (role/context/OLDER CONTEXT)
 *   @param {Number} [fields.systemPrefixTokens]
 *   @param {String} [fields.rawResponse]       Raw text returned by the model, pre-parse
 *   @param {Object} [fields.usage]
 *   @param {Array}  [fields.citations]
 *   @param {Object} [fields.result]            Parsed + post-processed result (as returned to the caller)
 *   @param {Object} [fields.contextSummary]    The rolling summary this call produced (stripped from `result`)
 *   @param {String} [fields.error]
 */
PipelineLogger.prototype.logCall = function (fields) {
    this._write({
        type: fields.type,
        request: {
            text:               fields.text,
            instructions:       fields.instructions,
            systemPrefixTokens: fields.systemPrefixTokens != null ? fields.systemPrefixTokens : null
        },
        response: {
            raw:       fields.rawResponse != null ? fields.rawResponse : null,
            usage:     fields.usage       || null,
            citations: fields.citations   || null
        },
        result:         fields.result         || null,
        contextSummary: fields.contextSummary || null,
        error:          fields.error          || null
    });
};

module.exports = PipelineLogger;
