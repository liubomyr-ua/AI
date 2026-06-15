'use strict';
/**
 * AI/Transcription/DeepgramStream — Deepgram real-time streaming STT adapter.
 *
 * Server-side Node.js adapter. Opens a WebSocket to Deepgram's streaming API,
 * forwards Int16 PCM chunks, and calls options.onUtterance() for each transcript.
 *
 * This is the server-side counterpart to AI/classes/AI/Voice/Deepgram.js,
 * which is the BROWSER-SIDE adapter for Q.Speech.Recognition.
 *
 * Config keys:
 *   AI/transcription/provider           — set to 'deepgram' to use this adapter
 *   AI/transcription/deepgram/key       — Deepgram API key
 *   AI/transcription/deepgram/endpointing — VAD endpointing ms (default: 300)
 *   AI/transcription/deepgram/interimResults — send interim results (default: true)
 *
 * @class AI_Transcription.DeepgramStream
 * @extends AI_Transcription
 */
var AI_Transcription = require('../Transcription');
var WebSocket = require('ws');

/**
 * @constructor
 * @param {Object} [options]
 */
AI_Transcription.DeepgramStream = function (options) {
    this._ws      = null;
    this._session = null;
    this._options = null;
};
AI_Transcription.DeepgramStream.prototype = Object.create(AI_Transcription.prototype);
AI_Transcription.DeepgramStream.prototype.constructor = AI_Transcription.DeepgramStream;

/**
 * @property platform
 * @type {String}
 */
AI_Transcription.DeepgramStream.prototype.platform = 'Deepgram';

/**
 * Open a WebSocket connection to Deepgram's streaming API.
 *
 * @method open
 * @param {Object} session
 * @param {Object} options
 * @param {Function} options.onUtterance  Called with each { transcript, isFinal, confidence, speaker }
 * @param {Function} [options.onError]    Called with Error on failure
 * @param {Object}   options.Q            Server-side Q object
 */
AI_Transcription.DeepgramStream.prototype.open = function (session, options) {
    var self = this;
    self._session = session;
    self._options = options;

    var Q      = options.Q;
    var apiKey = Q && Q.Config.get(['AI', 'transcription', 'deepgram', 'key'], null)
              || Q && Q.Config.get(['AI', 'deepgram', 'key'], null); // legacy fallback
    if (!apiKey) {
        if (options.onError) {
            options.onError(new Error('DeepgramStream: missing API key (AI/transcription/deepgram/key)'));
        }
        return;
    }

    var endpointing    = Q && Q.Config.get(['AI', 'transcription', 'deepgram', 'endpointing'], 300);
    var interimResults = Q && Q.Config.get(['AI', 'transcription', 'deepgram', 'interimResults'], true);

    var url = 'wss://api.deepgram.com/v1/listen'
        + '?language='       + encodeURIComponent(session.lang || 'en-US')
        + '&sample_rate='    + (session.sampleRate || 16000)
        + '&encoding=linear16&channels=1'
        + '&interim_results=' + (interimResults ? 'true' : 'false')
        + '&endpointing='    + endpointing
        + '&diarize=false';

    var ws = self._ws = new WebSocket(url, {
        headers: { Authorization: 'Token ' + apiKey }
    });

    ws.on('message', function (raw) {
        try {
            var msg = JSON.parse(raw);
            if (msg.type !== 'Results') return;
            var alt = msg.channel && msg.channel.alternatives && msg.channel.alternatives[0];
            if (!alt || !alt.transcript) return;
            var chunk = {
                transcript: alt.transcript,
                isFinal:    msg.is_final,
                confidence: alt.confidence != null ? alt.confidence : 1,
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
        self._ws = null;
    });
};

/**
 * Forward a PCM audio buffer to Deepgram.
 *
 * @method send
 * @param {Buffer|ArrayBuffer} pcmBuffer
 */
AI_Transcription.DeepgramStream.prototype.send = function (pcmBuffer) {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
        this._ws.send(pcmBuffer);
    }
};

/**
 * Close the Deepgram WebSocket.
 *
 * @method close
 */
AI_Transcription.DeepgramStream.prototype.close = function () {
    if (this._ws) {
        try { this._ws.close(); } catch (e) {}
        this._ws = null;
    }
    this._session = null;
    this._options = null;
};

module.exports = AI_Transcription.DeepgramStream;
