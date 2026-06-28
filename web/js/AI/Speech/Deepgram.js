"use strict";

/**
 * AI/web/js/AI/Speech/Deepgram.js
 *
 * Browser-side Deepgram streaming adapter for Q.Speech.Recognition.
 * Implements the { start, stop, abort } interface that
 * Q.Speech.Recognition.implement() expects, so callers like control.js
 * can keep their existing flow:
 *
 *     Q.Speech.Recognition.start({ lang: 'en-US' })
 *
 * and the audio gets routed through Deepgram instead of the browser API
 * once an adapter instance has been installed.
 *
 * The previous version of this file lived under
 *   AI/classes/AI/Voice/Deepgram.js
 * which was the wrong location on two counts:
 *   - `classes/` is for Node-side server classes; this is pure browser
 *     code (uses Q.info, getUserMedia, AudioContext, the /Q socket).
 *   - `Voice/` is for full-duplex realtime voice protocols (OpenAI
 *     Realtime, Gemini Live, Pipecat, LiveKit). Deepgram here is STT,
 *     a different concept that backs Q.Speech.Recognition.
 *
 * Installation happens via AI/web/js/AI.js on plugin activate when the
 * server config selects deepgram as the speech provider.
 *
 * SPEAKER IDENTITY MODEL
 * ──────────────────────
 * Each participant's device captures its own mic via getUserMedia and
 * streams audio over its own authenticated socket connection. The server
 * knows whose audio it is from the connection — no acoustic speaker ID
 * or diarization of a mixed stream. The { speaker } field in onResult
 * carries the authenticated userId set by the Node handler, not inferred
 * from audio. Host vs guest permissions hinge on socket identity, not
 * voice analysis, so a guest can't gain host permissions by mimicry.
 *
 * SERVER COMPANION
 * ────────────────
 * AI/classes/AI/Transcription/DeepgramStream.js receives the
 * AI/transcription/session/chunk audio bytes on the /Q socket and
 * forwards to Deepgram's WebSocket API. On transcript, it emits back to
 * the client via AI/transcription/result, which lands in _onTranscript
 * below. That result surfaces as Q.Speech.Recognition.onResult; Streams
 * then emits the single upstream Streams/utterance. The relay channel is
 * deliberately separate from Streams/utterance so the server's caption
 * echo doesn't feed back into recognition.
 *
 * @module AI
 * @class AI.Speech.Deepgram
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.AI         = root.AI         || {};
        root.AI.Speech  = root.AI.Speech  || {};
        root.AI.Speech.Deepgram = factory();
        if (typeof Q !== 'undefined' && Q.exports) {
            Q.exports(root.AI.Speech.Deepgram);
        }
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    /**
     * @param {Object} options
     * @param {String} [options.socketNs='/Q']      Socket.io namespace
     * @param {String} [options.socketUrl]          Node URL (defaults to Q.info.nodeUrl)
     * @param {Number} [options.sampleRate=16000]   PCM sample rate sent to Deepgram
     * @param {Number} [options.chunkMs=100]        Audio chunk interval in ms
     */
    function Deepgram(options) {
        options = options || {};
        this.socketNs   = options.socketNs   || '/Q';
        this.socketUrl  = options.socketUrl  ||
            (typeof Q !== 'undefined' && Q.info && Q.info.nodeUrl ? Q.info.nodeUrl : '');
        this.sampleRate = options.sampleRate || 16000;
        this.chunkMs    = options.chunkMs    || 100;

        this._socket       = null;
        this._mediaStream  = null;
        this._audioContext = null;
        this._processor    = null;
        this._active       = false;
    }

    // ── Q.Speech.Recognition interface ───────────────────────────────────────

    /**
     * Start audio capture and streaming. Called by Q.Speech.Recognition.start()
     * after this adapter has been installed via Q.Speech.Recognition.implement(this).
     *
     * @param {Object} [options]
     * @param {String} [options.lang='en-US']
     * @param {String} [options.source='microphone']  'microphone' or 'tab'
     */
    Deepgram.prototype.start = async function (options) {
        if (this._active) return;
        options = options || {};
        this._active = true;
        this._lang = options.lang || 'en-US';

        try {
            // 1. Connect socket
            this._socket = await this._connectSocket();

            // 2. Capture audio
            if (options.source === 'tab') {
                this._mediaStream = await navigator.mediaDevices.getDisplayMedia({
                    video: false,
                    audio: { echoCancellation: false, noiseSuppression: false }
                });
            } else {
                this._mediaStream = await navigator.mediaDevices.getUserMedia({
                    audio: { echoCancellation: true, noiseSuppression: true, sampleRate: this.sampleRate }
                });
            }

            // 3. Start PCM pipeline
            this._startAudioPipeline();

            // 4. Wire transcript + VAD events from socket
            this._socket.on('AI/transcription/result', this._onTranscript.bind(this));
            var self = this;
            this._socket.on('AI/vad/start', function () {
                Q.handle(Q.Speech.Recognition.onSpeechStart, Q.Speech.Recognition);
            });
            this._socket.on('AI/vad/end', function () {
                Q.handle(Q.Speech.Recognition.onSpeechEnd, Q.Speech.Recognition);
            });

            // 5. Wire on* shorthand handlers, matching the browser-path start()
            ['onStart', 'onEnd', 'onResult', 'onError', 'onSpeechStart', 'onSpeechEnd']
            .forEach(function (name) {
                if (options[name] && Q.Speech && Q.Speech.Recognition && Q.Speech.Recognition[name]) {
                    Q.Speech.Recognition[name].set(options[name], 'deepgramStart');
                }
            });

            // NOTE: AI/transcription/session/start is emitted by control.js's
            // _connectAISocket() with the full param set (publisherId,
            // streamName, role, mode). Don't emit a bare session/start here
            // or you create a stripped second session that overwrites it.

            Q.handle(Q.Speech.Recognition.onStart, Q.Speech.Recognition);

        } catch (err) {
            this._active = false;
            Q.handle(Q.Speech.Recognition.onError, Q.Speech.Recognition,
                [{ error: err.name === 'NotAllowedError' ? 'not-allowed' : 'audio-capture' }]);
        }
    };

    /**
     * Stop cleanly — flushes pending audio, fires onEnd.
     */
    Deepgram.prototype.stop = function () {
        if (!this._active) return;
        this._teardown('stop');
    };

    /**
     * Abort immediately — discards pending audio, fires onEnd.
     */
    Deepgram.prototype.abort = function () {
        if (!this._active) return;
        this._teardown('abort');
    };

    // ── Private ───────────────────────────────────────────────────────────────

    Deepgram.prototype._connectSocket = function () {
        var ns  = this.socketNs;
        var url = this.socketUrl;
        return new Promise(function (resolve, reject) {
            if (typeof Q !== 'undefined' && Q.Socket) {
                Q.Socket.connect(ns, url, null, {
                    earlyCallback: function (qs) {
                        // If already connected, resolve immediately — the
                        // 'connect' event won't fire again on an already-open
                        // socket, so the Promise would hang.
                        if (qs.connected) { resolve(qs.socket); return; }
                        qs.socket.on('connect', function () { resolve(qs.socket); });
                        qs.socket.on('connect_error', reject);
                    }
                });
            } else {
                var io = window.io;
                if (!io) { reject(new Error('socket.io not loaded')); return; }
                var s = io(url + ns, { transports: ['websocket'] });
                s.on('connect', function () { resolve(s); });
                s.on('connect_error', reject);
            }
        });
    };

    Deepgram.prototype._startAudioPipeline = function () {
        this._audioContext = new AudioContext({ sampleRate: this.sampleRate });
        var source = this._audioContext.createMediaStreamSource(this._mediaStream);

        // createScriptProcessor requires power-of-2 buffer size
        var rawSize = this.sampleRate * this.chunkMs / 1000;
        var bufferSize = 256;
        while (bufferSize < rawSize) bufferSize *= 2;

        var self = this;
        this._processor = this._audioContext.createScriptProcessor(bufferSize, 1, 1);
        this._processor.onaudioprocess = function (e) {
            if (!self._active || !self._socket) return;
            var float32 = e.inputBuffer.getChannelData(0);
            var int16   = new Int16Array(float32.length);
            for (var i = 0; i < float32.length; i++) {
                int16[i] = Math.max(-32768, Math.min(32767, Math.round(float32[i] * 32767)));
            }
            self._socket.emit('AI/transcription/session/chunk', int16.buffer);
        };

        source.connect(this._processor);
        // Do NOT connect processor to destination directly — that echoes mic
        // to speakers. Use a zero-gain node so onaudioprocess still fires.
        var silentGain = this._audioContext.createGain();
        silentGain.gain.value = 0;
        this._processor.connect(silentGain);
        silentGain.connect(this._audioContext.destination);
    };

    Deepgram.prototype._onTranscript = function (data) {
        // data: { transcript, isFinal, confidence, speaker, words? }
        Q.handle(Q.Speech.Recognition.onResult, Q.Speech.Recognition, [{
            transcript: data.transcript,
            isFinal:    data.isFinal,
            confidence: data.confidence != null ? data.confidence : 1,
            speaker:    data.speaker    || null,
            words:      data.words      || null
        }]);
    };

    Deepgram.prototype._teardown = function (how) {
        this._active = false;

        if (this._processor) {
            try { this._processor.disconnect(); } catch (e) {}
            this._processor = null;
        }
        if (this._audioContext) {
            try { this._audioContext.close(); } catch (e) {}
            this._audioContext = null;
        }
        if (this._mediaStream) {
            this._mediaStream.getTracks().forEach(function (t) { t.stop(); });
            this._mediaStream = null;
        }
        if (this._socket) {
            // 'AI/transcription/session/stop' or 'AI/transcription/session/abort'
            this._socket.emit('AI/transcription/session/' + how);
        }

        Q.handle(Q.Speech.Recognition.onEnd, Q.Speech.Recognition);
    };

    return Deepgram;
}));
