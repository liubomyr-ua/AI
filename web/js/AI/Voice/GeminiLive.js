/**
 * AI.Voice.GeminiLive — Google Gemini Live API protocol client.
 *
 * WebSocket-only (Gemini Live has no WebRTC transport, unlike OpenAI) --
 * see AI/classes/AI/Voice/Gemini.php for the ephemeral-token session broker.
 *
 * Wire protocol (BidiGenerateContent, single stateful WebSocket):
 *
 *   Client -> Server:
 *     {setup: {...}}                          first message, session config
 *     {realtimeInput: {audio: {data, mimeType}}}  base64 PCM16 16kHz chunk
 *     {activityStart: {}}  / {activityEnd: {}}    manual turn boundaries
 *       (only meaningful when the setup's realtimeInputConfig disabled
 *       automatic VAD -- see Gemini.php)
 *     {toolResponse: {functionResponses: [{id, name, response}]}}
 *
 *   Server -> Client:
 *     {setupComplete: {}}                     session ready
 *     {serverContent: {modelTurn, turnComplete, inputTranscription,
 *                       outputTranscription}}  incremental turn content
 *     {toolCall: {functionCalls: [{id, name, args}]}}
 *     {error: {...}}
 *
 * Unlike OpenAI, there is no separate "please respond now" event: in
 * manual-turn mode, sending activityEnd itself is what prompts the model to
 * respond -- so createResponse() is a no-op here (see its doc comment).
 * Likewise there's no OpenAI-style two-step "acknowledge, then optionally
 * continue" -- sending toolResponse is the only available action, so
 * respondToToolCall() and sendFunctionCallOutput() do the same thing.
 */
(function (root, factory) {
	if (typeof module === 'object' && module.exports) {
		module.exports = factory(require('../Voice'));
	} else {
		var impl = factory(root.AI.Voice);
		root.AI.GeminiLive = impl;
		if (typeof Q !== 'undefined' && Q.exports) {
			Q.exports(impl);
		}
	}
}(typeof self !== 'undefined' ? self : this, function (Voice) {
	'use strict';

	function Emitter() { this._listeners = {}; }
	Emitter.prototype.on = function (e, fn) {
		(this._listeners[e] = this._listeners[e] || []).push(fn); return this;
	};
	Emitter.prototype.emit = function (e) {
		var args = Array.prototype.slice.call(arguments, 1);
		(this._listeners[e] || []).forEach(function (fn) {
			try { fn.apply(null, args); } catch (err) {}
		});
	};

	var INPUT_SAMPLE_RATE = 16000;

	function GeminiLive(session, options) {
		Emitter.call(this);
		this.session = session;
		this.opts    = options || {};
		this.token   = session.token;
		this.wsUrl   = session.wsUrl;
		this._ws = null;
		this._stream = null;
		this._audioCtx = null;
		this._micWorklet = null;
		this._streaming = false; // gates whether captured PCM is actually sent
	}
	GeminiLive.prototype = Object.create(Emitter.prototype);
	GeminiLive.prototype.constructor = GeminiLive;

	GeminiLive.prototype.connect = function () {
		var self = this;
		return new Promise(function (resolve, reject) {
			var url = self.wsUrl
				+ (self.wsUrl.indexOf('?') === -1 ? '?' : '&')
				+ 'access_token=' + encodeURIComponent(self.token);
			var ws;
			try { ws = new WebSocket(url); } catch (e) { return reject(e); }
			self._ws = ws;

			ws.onopen = function () {
				// setupJSON, not a nested object -- see
				// AI_Voice_Gemini::createSession()'s doc comment on the
				// 'session' key: something in the server's response
				// pipeline corrupts nested object trees containing
				// "properties"/"required" keys, but a plain string survives
				// intact, so the server sends one and we reconstruct the
				// real object from it here instead of using session.setup
				// directly.
				var setupRaw = (self.session.session || {}).setupJSON;
				var setup = setupRaw ? JSON.parse(setupRaw) : {};
				_fixEmptyObjectFields(setup);
				var setupMsg = { setup: setup };
				var raw = JSON.stringify(setupMsg);
				// Log the actual JSON STRING being sent, not the live object
				// -- Chrome's console formats a logged object through its
				// own inspector (expandable [[Prototype]] trees etc.), which
				// doesn't reliably show whether a given value is really a {}
				// or a [] at a glance and isn't copy-pasteable as literal
				// wire content the way this string is.
				console.log('AI.Voice.GeminiLive: sending setup (raw JSON) ' + raw);
				ws.send(raw);
			};
			ws.onerror = function (err) {
				self.emit('error', err);
				if (!self._opened) reject(err);
			};
			ws.onclose = function (e) {
				// Google's server closes the socket immediately if the setup
				// message is rejected, with no other error event -- the
				// close code/reason is the only place that says why.
				console.log('AI.Voice.GeminiLive: socket closed', 'code=' + e.code, 'reason=' + e.reason, 'wasClean=' + e.wasClean);
				self.emit('close');
			};
			ws.onmessage = function (e) {
				self._readMessage(e.data).then(function (msg) {
					if (!msg) return;
					if (msg.setupComplete && !self._opened) {
						self._opened = true;
						self.emit('open');
						resolve();
					}
					self._handleEvent(msg);
				});
			};
		});
	};

	/**
	 * Gemini sends JSON as text frames (per the documented WebSocket API),
	 * but normalize defensively in case a Blob ever comes through.
	 * @private
	 */
	GeminiLive.prototype._readMessage = function (data) {
		if (typeof data === 'string') {
			try { return Promise.resolve(JSON.parse(data)); } catch (e) { return Promise.resolve(null); }
		}
		if (data instanceof Blob) {
			return data.text().then(function (text) {
				try { return JSON.parse(text); } catch (e) { return null; }
			});
		}
		return Promise.resolve(null);
	};

	// ─── Microphone capture ──────────────────────────────────────────

	/**
	 * @param {Object|MediaStreamTrack} input  getUserMedia() constraints, or
	 *   an existing MediaStreamTrack (cloned before use -- see
	 *   AI.Voice.OpenaiRealtime's startMicrophone for why: setMicEnabled()
	 *   must gate OUR copy, not silence the original for every other
	 *   consumer, e.g. speech recognition reading the same track).
	 */
	GeminiLive.prototype.startMicrophone = function (input) {
		var self = this;

		if (typeof MediaStreamTrack !== 'undefined' && input instanceof MediaStreamTrack) {
			var track = input.clone();
			return self._setupPcmPipeline(new MediaStream([track])).then(function () {
				self._stream = self._stream || new MediaStream([track]);
			});
		}

		if (typeof navigator === 'undefined' || !navigator.mediaDevices) {
			return Promise.reject(new Error('AI.Voice: navigator.mediaDevices unavailable'));
		}
		return navigator.mediaDevices.getUserMedia(input).then(function (stream) {
			return self._setupPcmPipeline(stream);
		});
	};

	/**
	 * Convert the stream to 16kHz PCM16 chunks (Gemini's required input
	 * format) and hold them ready to send -- actual sending is gated by
	 * setMicEnabled(), not by whether capture is running, so the pipeline
	 * can be set up well before any wake word (pre-warming) without
	 * streaming ambient audio the whole time.
	 * @private
	 */
	GeminiLive.prototype._setupPcmPipeline = function (stream) {
		var self = this;
		self._stream = stream;
		var AudioCtx = window.AudioContext || window.webkitAudioContext;
		var ctx = new AudioCtx({ sampleRate: INPUT_SAMPLE_RATE });
		self._audioCtx = ctx;
		var source = ctx.createMediaStreamSource(stream);
		// ScriptProcessor is deprecated but more portable than AudioWorklet
		// (matches OpenaiRealtime.js's WS fallback path for the same reason).
		var processor = ctx.createScriptProcessor(4096, 1, 1);
		self._micWorklet = processor;
		source.connect(processor);
		processor.connect(ctx.destination);

		processor.onaudioprocess = function (e) {
			if (!self._streaming) return;
			if (!self._ws || self._ws.readyState !== WebSocket.OPEN) return;
			var f32 = e.inputBuffer.getChannelData(0);
			var i16 = new Int16Array(f32.length);
			for (var i = 0; i < f32.length; i++) {
				var s = Math.max(-1, Math.min(1, f32[i]));
				i16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
			}
			self._ws.send(JSON.stringify({
				realtimeInput: {
					audio: {
						data: _bufferToB64(i16.buffer),
						mimeType: 'audio/pcm;rate=' + INPUT_SAMPLE_RATE
					}
				}
			}));
		};
		return Promise.resolve();
	};

	GeminiLive.prototype.stopMicrophone = function () {
		this._streaming = false;
		if (this._stream) {
			this._stream.getTracks().forEach(function (t) { t.stop(); });
			this._stream = null;
		}
		if (this._micWorklet) {
			try { this._micWorklet.disconnect(); } catch (e) {}
			this._micWorklet = null;
		}
		if (this._audioCtx) {
			try { this._audioCtx.close(); } catch (e) {}
			this._audioCtx = null;
		}
	};

	/**
	 * Gate whether captured audio is actually sent, AND signal the turn
	 * boundary Gemini needs in manual mode (activityStart/activityEnd are
	 * the equivalent of OpenAI's mic-track mute/unmute, but as explicit
	 * protocol messages rather than a media-level track property).
	 */
	GeminiLive.prototype.setMicEnabled = function (enabled) {
		this._streaming = !!enabled;
		if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
		if (enabled) {
			this._send({ activityStart: {} });
		}
		// Disabling doesn't send activityEnd here -- that's commitAudio()'s
		// job (see RealtimeSafebots.js: setMicEnabled(false) then
		// commitAudio() are two separate, deliberate calls).
	};

	/**
	 * Signals the end of the user's turn. Unlike OpenAI (where committing
	 * the buffer and asking for a response are two separate calls), sending
	 * activityEnd in manual mode is ITSELF what prompts Gemini to respond --
	 * see createResponse()'s doc comment.
	 */
	GeminiLive.prototype.commitAudio = function () {
		this._send({ activityEnd: {} });
	};

	// ─── Client → Server actions ─────────────────────────────────────

	GeminiLive.prototype.sendText = function (text, role) {
		this._send({
			clientContent: {
				turns: [{ role: role || 'user', parts: [{ text: text }] }],
				turnComplete: true
			}
		});
	};

	/**
	 * No-op for this protocol: activityEnd (commitAudio) is what prompts a
	 * response in manual-turn mode, and there's no separate "resume/continue
	 * the conversation" event the way OpenAI's response.create is. Present
	 * so callers written against the generic AI.Voice interface don't need
	 * to know which protocol they're talking to.
	 */
	GeminiLive.prototype.createResponse = function () {};

	GeminiLive.prototype.cancelResponse = function () {};

	/**
	 * Gemini has no OpenAI-style split between "acknowledge the tool call"
	 * and "acknowledge AND continue the conversation" -- sending toolResponse
	 * is the only available action, so this and sendFunctionCallOutput()
	 * behave identically.
	 */
	GeminiLive.prototype.respondToToolCall = function (callId, result) {
		this.sendFunctionCallOutput(callId, result);
	};

	GeminiLive.prototype.sendFunctionCallOutput = function (callId, result) {
		var response = (result && typeof result === 'object') ? result : { result: result };
		this._send({
			toolResponse: {
				functionResponses: [{ id: callId, response: response }]
			}
		});
	};

	GeminiLive.prototype.close = function () {
		this.stopMicrophone();
		if (this._ws) { try { this._ws.close(); } catch (e) {} this._ws = null; }
	};

	GeminiLive.prototype._send = function (obj) {
		if (this._ws && this._ws.readyState === WebSocket.OPEN) {
			this._ws.send(JSON.stringify(obj));
		} else {
			this.emit('error', new Error('AI.Voice.GeminiLive: no open connection to send on'));
		}
	};

	// ─── Server → Client events ──────────────────────────────────────

	GeminiLive.prototype._handleEvent = function (msg) {
		if (msg.error) {
			this.emit('error', new Error(msg.error.message || 'unknown error'));
			return;
		}

		if (msg.toolCall && Array.isArray(msg.toolCall.functionCalls)) {
			var self = this;
			msg.toolCall.functionCalls.forEach(function (fc) {
				self.emit('toolCall', {
					callId:    fc.id,
					name:      fc.name,
					arguments: fc.args || {}
				});
			});
			return;
		}

		var sc = msg.serverContent;
		if (!sc) return;

		if (sc.inputTranscription && typeof sc.inputTranscription.text === 'string') {
			// Simplification: Gemini's incremental-vs-final signaling for
			// transcription isn't used here -- each chunk is treated as the
			// latest known text and marked final, so the last one received
			// before a toolCall arrives is what RealtimeSafebots keeps
			// (see its 'transcript' handler, which just overwrites on every
			// final chunk -- functionally fine even if a chunk is really a
			// still-growing partial).
			this.emit('transcript', { role: 'user', text: sc.inputTranscription.text, isFinal: true });
		}
		if (sc.outputTranscription && typeof sc.outputTranscription.text === 'string') {
			this.emit('transcript', { role: 'assistant', text: sc.outputTranscription.text, isFinal: !!sc.turnComplete });
		}
		if (sc.turnComplete) {
			this.emit('responseDone', sc);
		}
	};

	/**
	 * PHP's empty-object markers (new stdClass(), meant to serialize as
	 * JSON "{}") for setup.tools[].googleSearch and
	 * setup.inputAudioTranscription can arrive here as [] instead --
	 * something in the server's response pipeline coerces an empty
	 * stdClass to an empty array/list somewhere between PHP and this
	 * client (confirmed NOT in AI_Voice_Gemini::createSession() or
	 * Q_JSON::encode() directly -- both produce {} when tested in
	 * isolation -- so it happens somewhere else in the response transport).
	 * Gemini's strict proto-JSON parser rejects an array where these
	 * singular message fields are expected ("Proto field is not
	 * repeating, cannot start"), so normalize defensively rather than
	 * chase the exact conversion point further.
	 * @private
	 */
	function _fixEmptyObjectFields(setup) {
		if (Array.isArray(setup.inputAudioTranscription)) {
			setup.inputAudioTranscription = {};
		}
		if (Array.isArray(setup.tools)) {
			setup.tools.forEach(function (t) {
				if (Array.isArray(t.googleSearch)) t.googleSearch = {};
			});
		}
	}

	function _bufferToB64(buf) {
		var bytes = new Uint8Array(buf);
		var binary = '';
		var chunk = 0x8000;
		for (var i = 0; i < bytes.length; i += chunk) {
			binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
		}
		return btoa(binary);
	}

	if (Voice && Voice.registerProtocol) {
		Voice.registerProtocol('gemini-live', GeminiLive);
	}

	return GeminiLive;
}));
