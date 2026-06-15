'use strict';
/**
 * AI/Transcription/AssemblyaiStream — AssemblyAI real-time streaming STT adapter.
 *
 * Server-side Node.js adapter. Opens a WebSocket to AssemblyAI's real-time API,
 * forwards Int16 PCM chunks, and calls options.onUtterance() for each transcript.
 *
 * AssemblyAI real-time API:
 *   wss://api.assemblyai.com/v2/realtime/ws?sample_rate=16000
 *   Auth: send JSON { "session_begins": false, "auth_token": "<key>" } as first message,
 *         OR pass token as query param (used here for simplicity).
 *   Send: binary Int16 PCM chunks
 *   Receive:
 *     { message_type: "SessionBegins", session_id, expires_at }
 *     { message_type: "PartialTranscript", text, confidence, words }  → isFinal:false
 *     { message_type: "FinalTranscript",   text, confidence, words }  → isFinal:true
 *     { message_type: "SessionTerminated" }
 *
 * Config keys:
 *   AI/transcription/provider              — set to 'assemblyai' to use this adapter
 *   AI/transcription/assemblyai/key        — AssemblyAI API key
 *   AI/transcription/assemblyai/wordBoost  — array of words to boost (optional)
 *
 * @class AI_Transcription.AssemblyaiStream
 * @extends AI_Transcription
 */
var AI_Transcription = require('../Transcription');
var WebSocket = require('ws');

/**
 * @constructor
 * @param {Object} [options]
 */
AI_Transcription.AssemblyaiStream = function (options) {
    this._ws      = null;
    this._session = null;
    this._options = null;
    this._ready   = false;
    this._queue   = []; // buffer chunks until SessionBegins received
};
AI_Transcription.AssemblyaiStream.prototype = Object.create(AI_Transcription.prototype);
AI_Transcription.AssemblyaiStream.prototype.constructor = AI_Transcription.AssemblyaiStream;

/**
 * @property platform
 * @type {String}
 */
AI_Transcription.AssemblyaiStream.prototype.platform = 'AssemblyAI';

/**
 * Open a WebSocket connection to AssemblyAI's real-time API.
 *
 * @method open
 * @param {Object} session
 * @param {Object} options
 * @param {Function} options.onUtterance  Called with each { transcript, isFinal, confidence, speaker }
 * @param {Function} [options.onError]    Called with Error on failure
 * @param {Object}   options.Q            Server-side Q object
 */
AI_Transcription.AssemblyaiStream.prototype.open = function (session, options) {
    var self = this;
    self._session = session;
    self._options = options;
    self._ready   = false;
    self._queue   = [];

    var Q      = options.Q;
    var apiKey = Q && Q.Config.get(['AI', 'transcription', 'assemblyai', 'key'], null)
              || Q && Q.Config.get(['AI', 'assemblyAI', 'key'], null); // legacy fallback
    if (!apiKey) {
        if (options.onError) {
            options.onError(new Error('AssemblyaiStream: missing API key (AI/transcription/assemblyai/key)'));
        }
        return;
    }

    var sampleRate = session.sampleRate || 16000;
    var wordBoost  = Q && Q.Config.get(['AI', 'transcription', 'assemblyai', 'wordBoost'], null);

    var url = 'wss://api.assemblyai.com/v2/realtime/ws'
        + '?sample_rate=' + sampleRate
        + '&token='       + encodeURIComponent(apiKey);
    if (wordBoost && Array.isArray(wordBoost) && wordBoost.length) {
        url += '&word_boost=' + encodeURIComponent(JSON.stringify(wordBoost));
    }

    var ws = self._ws = new WebSocket(url);

    ws.on('open', function () {
        // AssemblyAI handshake: send auth token as first JSON message
        // (belt-and-suspenders — token is also in the URL query param above)
        ws.send(JSON.stringify({ auth_token: apiKey }));
    });

    ws.on('message', function (raw) {
        try {
            var msg = JSON.parse(raw.toString());

            if (msg.message_type === 'SessionBegins') {
                self._ready = true;
                // Flush any PCM chunks that arrived before the session was ready
                self._queue.forEach(function (buf) {
                    if (ws.readyState === WebSocket.OPEN) ws.send(buf);
                });
                self._queue = [];
                return;
            }

            if (msg.message_type === 'SessionTerminated') {
                self._ready = false;
                return;
            }

            if (msg.message_type !== 'PartialTranscript'
            &&  msg.message_type !== 'FinalTranscript') return;

            var text = msg.text || '';
            if (!text) return; // AssemblyAI sends empty partials during silence

            var chunk = {
                transcript: text,
                isFinal:    msg.message_type === 'FinalTranscript',
                confidence: msg.confidence != null ? msg.confidence : 1,
                speaker:    session.userId
            };
            if (self._options && self._options.onUtterance) {
                self._options.onUtterance(chunk);
            }
        } catch (e) {}
    });

    ws.on('error', function (e) {
        if (self._options && self._options.onError) {
            self._options.onError(e);
        }
    });

    ws.on('close', function () {
        self._ws    = null;
        self._ready = false;
        self._queue = [];
    });
};

/**
 * Forward a PCM audio buffer to AssemblyAI.
 * Buffers chunks until SessionBegins is received.
 *
 * @method send
 * @param {Buffer|ArrayBuffer} pcmBuffer
 */
AI_Transcription.AssemblyaiStream.prototype.send = function (pcmBuffer) {
    if (!this._ws) return;
    if (!this._ready) {
        // Queue until session is ready — AssemblyAI drops audio sent before SessionBegins
        this._queue.push(pcmBuffer);
        // Cap queue at ~5s of audio at 16kHz Int16 to avoid unbounded memory use
        var maxBytes = 16000 * 2 * 5;
        var total = this._queue.reduce(function (s, b) { return s + b.byteLength; }, 0);
        while (total > maxBytes && this._queue.length > 1) {
            total -= this._queue.shift().byteLength;
        }
        return;
    }
    if (this._ws.readyState === WebSocket.OPEN) {
        this._ws.send(pcmBuffer);
    }
};

/**
 * Close the AssemblyAI WebSocket.
 *
 * @method close
 */
AI_Transcription.AssemblyaiStream.prototype.close = function () {
    if (this._ws) {
        try {
            // AssemblyAI: send terminate message before closing
            if (this._ws.readyState === WebSocket.OPEN) {
                this._ws.send(JSON.stringify({ terminate_session: true }));
            }
            this._ws.close();
        } catch (e) {}
        this._ws = null;
    }
    this._session = null;
    this._options = null;
    this._ready   = false;
    this._queue   = [];
};

module.exports = AI_Transcription.AssemblyaiStream;
