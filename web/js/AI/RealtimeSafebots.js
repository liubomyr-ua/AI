"use strict";

/**
 * AI/web/js/AI/RealtimeSafebots.js
 *
 * Bridges AI.WakeWord (text-based wake-word detection, see WakeWord.js) with
 * AI.Voice (the OpenAI Realtime API client, see Voice.js) so a detected wake
 * command streams mic audio straight to a Realtime session instead of
 * relying purely on the text-model pipeline.
 *
 * This is an experiment running ALONGSIDE the existing text-model path, not
 * a replacement for it -- WakeWord's own 'command' event still fires
 * (see Media/presentation/commands.js), still sends the assembled text to
 * 'AI/safebots/request', and is handled exactly as before. This class only
 * ADDS a second, parallel answer path so the two can be compared.
 *
 * Design notes:
 *   - The Realtime connection is established once, well before any wake
 *     word (pre-warmed), and its lifetime is independent of the ~60s
 *     ephemeral token used to establish it -- once the WebRTC session is up,
 *     it stays up. If it drops, this reconnects automatically (fetching a
 *     fresh ephemeral token, since the old one is one-time-use).
 *   - No rolling context is sent to the Realtime model -- the server-side
 *     session (see AI/handlers/AI/voice/post.php) configures it with
 *     just enough instructions + a single `report_visualization` function
 *     tool to turn one isolated voice command into the same
 *     {action, visualizationType, visualizationData, ...} shape the text
 *     pipeline already produces.
 *   - The mic track is added to the peer connection up front but starts
 *     muted (see Voice.prototype.setMicEnabled) -- real audio only flows
 *     while a wake word is open (wakeStart..wakeEnd), gated by muting
 *     in place rather than adding/removing the track (which would require
 *     renegotiating the connection -- not supported by OpenAI's one-shot
 *     SDP exchange).
 *   - turn_detection is off server-side (manual mode): WakeWord's own
 *     start/end boundaries are more reliable than a second, independent
 *     VAD would be, so wakeEnd explicitly commits the audio buffer and
 *     requests a response instead of waiting for the model to notice
 *     silence on its own.
 *
 * Usage (see Media/presentation/commands.js's _connectRealtimeSafebots):
 *   Q.require([
 *       Q.url('{{AI}}/js/AI/Voice.js'),
 *       Q.url('{{AI}}/js/AI/Voice/OpenaiRealtime.js'),
 *       Q.url('{{AI}}/js/AI/RealtimeSafebots.js')
 *   ], function (Voice, OpenaiRealtime, RealtimeSafebots) {
 *       var rt = new RealtimeSafebots(wakeWordInstance, { Voice: Voice });
 *       rt.on('result', function (result) { ...send to server... });
 *       rt.on('error', function (err) { ... });
 *       rt.connect();
 *   });
 *
 * @module AI
 * @class AI.RealtimeSafebots
 */
(function (root, factory) {
	if (typeof module === 'object' && module.exports) {
		module.exports = factory();
	} else {
		root.AI = root.AI || {};
		root.AI.RealtimeSafebots = factory();
		if (typeof Q !== 'undefined' && Q.exports) {
			Q.exports(root.AI.RealtimeSafebots);
		}
	}
}(typeof self !== 'undefined' ? self : this, function () {
	'use strict';

	function Emitter() { this._listeners = {}; }
	Emitter.prototype.on = function (ev, fn) {
		(this._listeners[ev] = this._listeners[ev] || []).push(fn);
		return this;
	};
	Emitter.prototype.off = function (ev, fn) {
		if (!this._listeners[ev]) return this;
		this._listeners[ev] = this._listeners[ev].filter(function (f) { return f !== fn; });
		return this;
	};
	Emitter.prototype.emit = function (ev) {
		var args = Array.prototype.slice.call(arguments, 1);
		(this._listeners[ev] || []).forEach(function (fn) {
			try { fn.apply(null, args); } catch (e) { /* swallow listener errors */ }
		});
	};

	var TOOL_NAME = 'report_visualization';
	var RESPONSE_TIMEOUT_MS = 10000;
	var RECONNECT_MIN_MS = 2000;
	var RECONNECT_MAX_MS = 15000;
	// OpenAI rejects input_audio_buffer.commit with less than 100ms of
	// audio; require a bit more than that as a safety margin against clock
	// jitter between when we unmute and when the first real audio frame
	// actually reaches the server.
	var MIN_AUDIO_MS = 150;

	/**
	 * @param {AI.WakeWord} wakeWord  Drives when to open/close the mic --
	 *   this class only listens to its events, never touches its text
	 *   detection logic.
	 * @param {Object} options
	 * @param {Function} options.Voice  The AI.Voice constructor (passed in
	 *   rather than looked up globally, since the caller already had to
	 *   Q.require it to get here).
	 * @param {MediaStreamTrack} [options.audioTrack]  An existing audio
	 *   track to stream to the Realtime session instead of opening a
	 *   separate microphone capture -- e.g. Media/presentation/commands.js's
	 *   tool.state.audioTrack, when speech recognition is already reading
	 *   from a specific, non-default source. Falls back to a fresh
	 *   getUserMedia() capture when omitted.
	 */
	function RealtimeSafebots(wakeWord, options) {
		Emitter.call(this);
		this.wakeWord = wakeWord;
		this.options  = options || {};
		this.voice    = null;
		this.state    = 'idle';   // idle | connecting | ready | listening
		this._destroyed        = false;
		this._reconnectDelay   = RECONNECT_MIN_MS;
		this._reconnectTimer   = null;
		this._responseTimeout  = null;
		this._lastUserTranscript = '';
		this._listeningStartedAt = null;

		var self = this;
		this._onWakeStartBound = function () { self._onWakeStart(); };
		this._onWakeEndBound   = function (fullCommand) { self._onWakeEnd(fullCommand); };
		wakeWord.on('wakeStart', this._onWakeStartBound);
		wakeWord.on('wakeEnd',   this._onWakeEndBound);
	}
	RealtimeSafebots.prototype = Object.create(Emitter.prototype);
	RealtimeSafebots.prototype.constructor = RealtimeSafebots;

	// ── Connection lifecycle ───────────────────────────────────────────────

	/**
	 * Fetch a fresh ephemeral session and connect. Safe to call repeatedly --
	 * no-ops while already connecting/connected. This is also what
	 * _scheduleReconnect() calls after a drop, so every (re)connect gets its
	 * own fresh token and fresh RTCPeerConnection (a closed one can't be
	 * reused).
	 */
	RealtimeSafebots.prototype.connect = function () {
		var self = this;
		if (self._destroyed) return;
		if (self.state === 'connecting' || self.state === 'ready' || self.state === 'listening') {
			return;
		}
		self.state = 'connecting';
		self._cleanupVoice();

		self._fetchSession().then(function (session) {
			if (self._destroyed) return;
			return self._connectWithSession(session);
		}).catch(function (err) {
			if (self._destroyed) return;
			self.state = 'idle';
			self.emit('error', err);
			self._scheduleReconnect();
		});
	};

	RealtimeSafebots.prototype._fetchSession = function () {
		return new Promise(function (resolve, reject) {
			if (typeof Q === 'undefined' || !Q.req) {
				return reject(new Error('AI.RealtimeSafebots: Q.req unavailable'));
			}
			Q.req('AI/voice', 'data', function (err, response) {
				var msg = Q.firstErrorMessage(err)
					|| (response && Q.firstErrorMessage(response.errors));
				if (msg) return reject(new Error(msg));
				var session = response && response.slots && response.slots.data;
				if (!session) return reject(new Error('AI.RealtimeSafebots: empty session response'));
				// TEMPORARY diagnostic -- logging the session exactly as
				// received from the server, before any client code (Voice.js,
				// GeminiLive.js) touches it, to isolate whether
				// setup.tools[].functionDeclarations[].parameters.properties.*
				// already arrives corrupted here or gets mangled later.
				console.log('AI.RealtimeSafebots: session received from server (raw JSON) ' + JSON.stringify(session));
				resolve(session);
			}, { method: 'post' });
		});
	};

	RealtimeSafebots.prototype._connectWithSession = function (session) {
		var self = this;
		var Voice = self.options.Voice
			|| (typeof Q !== 'undefined' && Q.AI && Q.AI.Voice);
		if (!Voice) return Promise.reject(new Error('AI.RealtimeSafebots: AI.Voice not loaded'));

		var voice = new Voice(session);
		self.voice = voice;

		voice.on('open', function () {
			if (self.voice !== voice) return; // superseded by a later (re)connect
			self.state = 'ready';
			self._reconnectDelay = RECONNECT_MIN_MS;
			self.emit('ready');
		});
		voice.on('close', function () {
			if (self.voice !== voice) return;
			self._onDisconnected();
		});
		voice.on('error', function (err) {
			if (self.voice !== voice) return;
			self.emit('error', err);
		});
		voice.on('toolCall', function (call) {
			if (self.voice !== voice) return;
			self._onToolCall(call);
		});
		voice.on('responseDone', function () {
			if (self.voice !== voice) return;
			clearTimeout(self._responseTimeout);
		});
		voice.on('transcript', function (t) {
			if (self.voice !== voice) return;
			if (t && t.role === 'user' && t.isFinal && t.text) {
				self._lastUserTranscript = t.text;
			}
		});

		// Acquire + mute the mic BEFORE connect() -- see Voice.js/
		// OpenaiRealtime.js doc comments on why order matters for WebRTC.
		// options.audioTrack, when given, is used directly instead of
		// opening a separate getUserMedia() capture (see OpenaiRealtime.js's
		// startMicrophone() for why it's cloned rather than shared as-is).
		return voice.startMicrophone(self.options.audioTrack || { audio: true }).then(function () {
			voice.setMicEnabled(false);
			return voice.connect();
		});
	};

	RealtimeSafebots.prototype._cleanupVoice = function () {
		if (this.voice) {
			try { this.voice.close(); } catch (e) { /* ignore */ }
			this.voice = null;
		}
	};

	RealtimeSafebots.prototype._onDisconnected = function () {
		var wasConnecting = this.state !== 'idle';
		this.state = 'idle';
		this.voice = null;
		this.emit('disconnected');
		if (!this._destroyed && wasConnecting) this._scheduleReconnect();
	};

	RealtimeSafebots.prototype._scheduleReconnect = function () {
		var self = this;
		if (self._destroyed || self._reconnectTimer) return;
		self._reconnectTimer = setTimeout(function () {
			self._reconnectTimer = null;
			self.connect();
		}, self._reconnectDelay);
		self._reconnectDelay = Math.min(self._reconnectDelay * 2, RECONNECT_MAX_MS);
	};

	// ── Wake-word integration ───────────────────────────────────────────────

	RealtimeSafebots.prototype._onWakeStart = function () {
		if (this.state !== 'ready') {
			// Not connected right now (still connecting, or mid-reconnect) --
			// nothing to stream to. The text-model path (WakeWord's own
			// 'command' event, handled independently in commands.js) still
			// covers this request either way.
			return;
		}
		this.state = 'listening';
		this._lastUserTranscript = '';
		this._listeningStartedAt = Date.now();
		this.voice.setMicEnabled(true);
	};

	RealtimeSafebots.prototype._onWakeEnd = function () {
		if (this.state !== 'listening' || !this.voice) return;
		this.state = 'ready';
		this.voice.setMicEnabled(false);

		// Wake detection is text-based (WakeWord.js), which can complete
		// arbitrarily fast -- e.g. a short "Hey Safebots, <command>, thanks"
		// recognized as a single utterance fires wakeStart and wakeEnd back
		// to back. OpenAI requires >=100ms of committed audio; skip the
		// commit/response entirely below that, rather than erroring on an
		// empty buffer every time. The text-model path (WakeWord's own
		// 'command' event, handled independently in commands.js) still
		// covers this request either way, so nothing is lost.
		var elapsed = Date.now() - (this._listeningStartedAt || 0);
		if (elapsed < MIN_AUDIO_MS) return;

		try {
			this.voice.commitAudio();
			this.voice.createResponse({
				output_modalities: ['text'],
				tool_choice:       { type: 'function', name: TOOL_NAME }
			});
		} catch (e) {
			this.emit('error', e);
			return;
		}

		var self = this;
		clearTimeout(self._responseTimeout);
		self._responseTimeout = setTimeout(function () {
			self.emit('error', new Error('AI.RealtimeSafebots: no response within '
				+ RESPONSE_TIMEOUT_MS + 'ms'));
		}, RESPONSE_TIMEOUT_MS);
	};

	RealtimeSafebots.prototype._onToolCall = function (call) {
		clearTimeout(this._responseTimeout);
		if (!call || call.name !== TOOL_NAME) return;

		var result = call.arguments || {};
		result.wakeRequest = this._lastUserTranscript || null;
		this.emit('result', result);

		// Acknowledge so the session's own turn bookkeeping doesn't stall
		// waiting on a function_call_output that would otherwise never come
		// -- sendFunctionCallOutput, NOT respondToToolCall: the latter also
		// fires a new response.create(), which would make the model call
		// report_visualization again, whose acknowledgment would trigger
		// yet another response.create(), and so on -- report_visualization's
		// arguments already ARE the answer; nothing more needs saying.
		if (this.voice && call.callId) {
			try { this.voice.sendFunctionCallOutput(call.callId, { ok: true }); } catch (e) { /* ignore */ }
		}
	};

	// ── Cleanup ──────────────────────────────────────────────────────────────

	RealtimeSafebots.prototype.destroy = function () {
		this._destroyed = true;
		clearTimeout(this._reconnectTimer);
		clearTimeout(this._responseTimeout);
		this.wakeWord.off('wakeStart', this._onWakeStartBound);
		this.wakeWord.off('wakeEnd',   this._onWakeEndBound);
		this._cleanupVoice();
	};

	return RealtimeSafebots;
}));
