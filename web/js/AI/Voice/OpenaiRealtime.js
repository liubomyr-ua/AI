/**
 * AI.Voice.OpenaiRealtime — OpenAI Realtime API protocol client.
 *
 * Also covers xAI Grok Voice Think Fast (wire-compatible) and Azure
 * OpenAI Realtime (same wire, different endpoint).
 *
 * Two transport modes:
 *   1. WebRTC (preferred for browsers, lower latency, native echo cancel)
 *      - Used when session.wrtcUrl is set
 *      - SDP exchange via POST to wrtcUrl with the ephemeral token
 *      - Data channel "oai-events" carries the JSON event protocol
 *      - Audio tracks carry the PCM streams
 *   2. WebSocket (server-to-server, or browsers when WebRTC unavailable)
 *      - Used when session.wrtcUrl is null
 *      - All events including base64-encoded audio over WS
 *
 * The class auto-selects based on session and environment. Forces
 * WebSocket via constructor option { transport: 'ws' } when needed.
 *
 * Event protocol (per OpenAI Realtime spec, May 2026):
 *
 *   Client → Server:
 *     session.update                    config the session
 *     input_audio_buffer.append         { audio: base64 }     (WS only; WebRTC sends via track)
 *     input_audio_buffer.commit         force-commit a turn (when VAD off)
 *     conversation.item.create          inject text or function output
 *     response.create                   ask model to respond
 *     response.cancel                   interrupt in-progress response
 *
 *   Server → Client:
 *     session.created / session.updated      lifecycle
 *     input_audio_buffer.speech_started      VAD detected speech
 *     input_audio_buffer.speech_stopped      VAD detected silence
 *     conversation.item.input_audio_transcription.delta  user transcript chunks
 *     response.audio.delta                   assistant audio chunk (base64 on WS)
 *     response.audio_transcript.delta        assistant transcript chunks
 *     response.audio.done / .transcript.done end-of-utterance
 *     response.done                          full response complete
 *     response.function_call_arguments.done  tool call ready
 *     error                                  error event
 */
(function (root, factory) {
	if (typeof module === 'object' && module.exports) {
		module.exports = factory(require('../Voice'));
	} else {
		var impl = factory(root.AI.Voice);
		root.AI.OpenaiRealtime = impl;
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

	function OpenaiRealtime(session, options) {
		Emitter.call(this);
		this.session = session;
		this.opts = options || {};
		this.transport = this.opts.transport || (session.wrtcUrl ? 'webrtc' : 'ws');
		this.token   = session.token;
		this.wsUrl   = session.wsUrl;
		this.wrtcUrl = session.wrtcUrl;
		this.tokenSubprotocol = session.tokenSubprotocol || null; // xAI: 'xai-client-secret'
		this._ws = null;
		this._pc = null;
		this._dc = null;
		this._stream = null;
		this._audioCtx = null;
		this._micWorklet = null;
	}
	OpenaiRealtime.prototype = Object.create(Emitter.prototype);
	OpenaiRealtime.prototype.constructor = OpenaiRealtime;

	OpenaiRealtime.prototype.connect = function () {
		return this.transport === 'webrtc' ? this._connectWebRtc() : this._connectWebSocket();
	};

	// ─── WebSocket transport ─────────────────────────────────────────

	OpenaiRealtime.prototype._connectWebSocket = function () {
		var self = this;
		return new Promise(function (resolve, reject) {
			var protocols = [];
			if (self.tokenSubprotocol) {
				// xAI: subprotocol-based token auth
				protocols.push(self.tokenSubprotocol + '.' + self.token);
			}
			var ws;
			try {
				ws = protocols.length
					? new WebSocket(self.wsUrl, protocols)
					: new WebSocket(self.wsUrl);
			} catch (e) {
				return reject(e);
			}
			self._ws = ws;

			ws.onopen = function () {
				// If we're not using subprotocol auth (OpenAI/Azure), we need
				// to send the auth header via session.update or as a
				// Authorization: Bearer header on the WS handshake. Browsers
				// don't allow setting custom headers on WS handshake; the
				// recommended path is the ephemeral token in the URL or via
				// the first message:
				//   { type: 'auth', token: '...' }
				// OpenAI's real auth model expects the Authorization header,
				// which is impractical from a browser; the WebRTC path is
				// the supported one for browsers. If the user is forcing WS
				// from a browser, they need a server-side proxy.
				if (!self.tokenSubprotocol && self.token) {
					ws.send(JSON.stringify({ type: 'auth', authorization: 'Bearer ' + self.token }));
				}
				// Apply session config.
				ws.send(JSON.stringify({
					type:    'session.update',
					session: self.session.session || {}
				}));
				self.emit('open');
				resolve();
			};
			ws.onerror = function (err) {
				self.emit('error', err);
				if (!self._opened) reject(err);
			};
			ws.onclose = function () {
				self.emit('close');
			};
			ws.onmessage = function (e) {
				var msg;
				try { msg = JSON.parse(typeof e.data === 'string' ? e.data : ''); }
				catch (err) { return; }
				self._handleEvent(msg);
			};
		});
	};

	// ─── WebRTC transport ────────────────────────────────────────────

	OpenaiRealtime.prototype._connectWebRtc = function () {
		var self = this;
		return new Promise(function (resolve, reject) {
			if (typeof RTCPeerConnection === 'undefined') {
				return reject(new Error('AI.Voice.OpenaiRealtime: WebRTC not available in this environment'));
			}
			var pc = new RTCPeerConnection();
			self._pc = pc;

			// Set up audio playback for incoming model audio.
			pc.ontrack = function (ev) {
				var audio = document.createElement('audio');
				audio.autoplay = true;
				audio.srcObject = ev.streams[0];
				self._modelAudioEl = audio;
				// Don't append to DOM — the audio plays via the track.
			};

			// If startMicrophone() already ran (the supported pre-warming
			// flow -- see AI.RealtimeSafebots), add its track now so the
			// initial SDP offer includes the audio m-line. OpenAI's WebRTC
			// exchange is a single one-shot POST with no renegotiation
			// endpoint, so a track added AFTER this offer/answer would never
			// reach the server -- gate with setMicEnabled() instead of
			// adding a track later.
			//
			// Plain addTrack (sendrecv), not a sendonly transceiver: an
			// earlier attempt to skip negotiating a receive path this way
			// resulted in OpenAI's server never actually buffering any of
			// the sent audio (input_audio_buffer.commit failed with
			// "0.00ms of audio" regardless of how long the mic was
			// unmuted) -- this endpoint doesn't seem to handle a
			// sendonly-offered audio m-line correctly. "No audio reply
			// wanted" is already handled correctly at the session level
			// (output_modalities:['text'], no audio.output block at all --
			// see AI_Voice_Openai::createSession()); a sendrecv m-line that
			// the model just never sends anything on is harmless.
			if (self._stream) {
				self._stream.getTracks().forEach(function (t) { pc.addTrack(t, self._stream); });
			}

			// Data channel for events.
			var dc = pc.createDataChannel('oai-events');
			self._dc = dc;
			dc.onopen = function () {
				dc.send(JSON.stringify({
					type:    'session.update',
					session: self.session.session || {}
				}));
				self.emit('open');
				resolve();
			};
			dc.onmessage = function (e) {
				var msg;
				try { msg = JSON.parse(e.data); }
				catch (err) { return; }
				self._handleEvent(msg);
			};
			dc.onclose = function () { self.emit('close'); };
			dc.onerror = function (err) { self.emit('error', err); };

			// SDP offer/answer.
			pc.createOffer().then(function (offer) {
				return pc.setLocalDescription(offer);
			}).then(function () {
				return fetch(self.wrtcUrl, {
					method:  'POST',
					body:    pc.localDescription.sdp,
					headers: {
						'Content-Type':  'application/sdp',
						'Authorization': 'Bearer ' + self.token
					}
				});
			}).then(function (resp) {
				if (!resp.ok) {
					return resp.text().then(function (t) {
						throw new Error('AI.Voice.OpenaiRealtime: SDP exchange failed (' + resp.status + '): ' + t);
					});
				}
				return resp.text();
			}).then(function (answerSdp) {
				return pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
			}).catch(reject);
		});
	};

	// ─── Microphone capture ──────────────────────────────────────────

	/**
	 * @param {Object|MediaStreamTrack} input  Either getUserMedia()
	 *   constraints (default), or an existing MediaStreamTrack to use
	 *   directly -- e.g. Media/presentation/commands.js's
	 *   tool.state.audioTrack, so speech recognition and the Realtime
	 *   session both draw from the same audio source instead of opening a
	 *   second, independent microphone capture.
	 */
	OpenaiRealtime.prototype.startMicrophone = function (input) {
		var self = this;

		if (typeof MediaStreamTrack !== 'undefined' && input instanceof MediaStreamTrack) {
			// Clone it: setMicEnabled() gates OUR clone's .enabled flag, not
			// the original track's. Muting the original would also silence
			// it for every other consumer -- including the always-on speech
			// recognition WakeWord.js depends on to detect the wake word in
			// the first place. clone() shares the same underlying capture
			// device/source but has an independent enabled/stop lifecycle.
			var track  = input.clone();
			var stream = new MediaStream([track]);
			self._stream = stream;
			if (self.transport === 'webrtc') {
				if (self._pc) {
					self._pc.addTrack(track, stream);
				}
				// else: _connectWebRtc() will add it before creating the offer.
			} else {
				self._streamPcmOverWs(stream);
			}
			return Promise.resolve();
		}

		var constraints = input;
		if (typeof navigator === 'undefined' || !navigator.mediaDevices) {
			return Promise.reject(new Error('AI.Voice: navigator.mediaDevices unavailable'));
		}
		return navigator.mediaDevices.getUserMedia(constraints).then(function (stream) {
			self._stream = stream;
			if (self.transport === 'webrtc') {
				if (self._pc) {
					// Called after connect() -- best-effort only. This
					// requires renegotiation that OpenAI's one-shot SDP
					// exchange doesn't support, so the track likely won't
					// actually reach the server. Prefer calling
					// startMicrophone() BEFORE connect(): _connectWebRtc()
					// picks up self._stream and adds it to the initial offer.
					stream.getTracks().forEach(function (t) { self._pc.addTrack(t, stream); });
				}
				// else: _connectWebRtc() will add these tracks itself, right
				// before creating the initial offer.
			} else {
				self._streamPcmOverWs(stream);
			}
		});
	};

	OpenaiRealtime.prototype._streamPcmOverWs = function (stream) {
		var self = this;
		// Convert input stream to 24kHz PCM16 chunks and base64-encode
		// over the WebSocket.
		var AudioCtx = window.AudioContext || window.webkitAudioContext;
		var ctx = new AudioCtx({ sampleRate: 24000 });
		self._audioCtx = ctx;
		var source = ctx.createMediaStreamSource(stream);
		// ScriptProcessor is deprecated but more portable than AudioWorklet.
		// Production code should use AudioWorklet.
		var processor = ctx.createScriptProcessor(4096, 1, 1);
		self._micWorklet = processor;
		source.connect(processor);
		processor.connect(ctx.destination);

		processor.onaudioprocess = function (e) {
			var f32 = e.inputBuffer.getChannelData(0);
			var i16 = new Int16Array(f32.length);
			for (var i = 0; i < f32.length; i++) {
				var s = Math.max(-1, Math.min(1, f32[i]));
				i16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
			}
			var b64 = _bufferToB64(i16.buffer);
			if (self._ws && self._ws.readyState === WebSocket.OPEN) {
				self._ws.send(JSON.stringify({
					type:  'input_audio_buffer.append',
					audio: b64
				}));
			}
		};
	};

	/**
	 * Mute/unmute the already-added mic track in place -- no renegotiation,
	 * just gates whether real audio (vs. silence) actually reaches the
	 * model. This is how AI.RealtimeSafebots turns streaming on/off in sync
	 * with wake-word start/end without touching the peer connection itself.
	 */
	OpenaiRealtime.prototype.setMicEnabled = function (enabled) {
		if (!this._stream) return;
		this._stream.getAudioTracks().forEach(function (t) { t.enabled = !!enabled; });
	};

	/**
	 * Manually commit the input audio buffer. Required in manual/push-to-talk
	 * mode (session configured with turn_detection:null) before requesting a
	 * response -- with server VAD this happens automatically instead.
	 */
	OpenaiRealtime.prototype.commitAudio = function () {
		this._send({ type: 'input_audio_buffer.commit' });
	};

	OpenaiRealtime.prototype.stopMicrophone = function () {
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

	// ─── Client → Server actions ─────────────────────────────────────

	OpenaiRealtime.prototype.sendText = function (text, role) {
		this._send({
			type: 'conversation.item.create',
			item: {
				type:    'message',
				role:    role || 'user',
				content: [{ type: 'input_text', text: text }]
			}
		});
	};

	OpenaiRealtime.prototype.respondToToolCall = function (callId, result) {
		this.sendFunctionCallOutput(callId, result);
		// After tool output, ask for a response -- this is the right default
		// for a normal assistant flow (tool call -> speak the result back),
		// but a caller whose flow ends AT the tool call (a single-shot
		// "answer via function call" pattern with nothing further to say)
		// should use sendFunctionCallOutput() directly instead: chaining
		// another response.create() here would make the model call the
		// function again, whose acknowledgment would trigger yet another
		// response.create(), and so on.
		this._send({ type: 'response.create' });
	};

	/**
	 * Send a function call's output without automatically continuing the
	 * conversation. Use this instead of respondToToolCall() when nothing
	 * further should be said after the tool call -- e.g. AI.RealtimeSafebots,
	 * where report_visualization's arguments ARE the answer and chaining a
	 * response.create() would just make the model call it again.
	 */
	OpenaiRealtime.prototype.sendFunctionCallOutput = function (callId, result) {
		this._send({
			type: 'conversation.item.create',
			item: {
				type:    'function_call_output',
				call_id: callId,
				output:  typeof result === 'string' ? result : JSON.stringify(result)
			}
		});
	};

	OpenaiRealtime.prototype.createResponse = function (options) {
		this._send({
			type:     'response.create',
			response: options || {}
		});
	};

	OpenaiRealtime.prototype.cancelResponse = function () {
		this._send({ type: 'response.cancel' });
	};

	OpenaiRealtime.prototype.close = function () {
		this.stopMicrophone();
		if (this._dc) { try { this._dc.close(); } catch (e) {} this._dc = null; }
		if (this._pc) { try { this._pc.close(); } catch (e) {} this._pc = null; }
		if (this._ws) { try { this._ws.close(); } catch (e) {} this._ws = null; }
	};

	OpenaiRealtime.prototype._send = function (obj) {
		var msg = JSON.stringify(obj);
		if (this._dc && this._dc.readyState === 'open') {
			this._dc.send(msg);
		} else if (this._ws && this._ws.readyState === WebSocket.OPEN) {
			this._ws.send(msg);
		} else {
			this.emit('error', new Error('AI.Voice.OpenaiRealtime: no open channel to send'));
		}
	};

	// ─── Server → Client events ──────────────────────────────────────

	OpenaiRealtime.prototype._handleEvent = function (msg) {
		var self = this;
		var t = msg.type;

		// Lifecycle
		if (t === 'session.created' || t === 'session.updated') {
			this.emit('sessionUpdated', msg.session);
			return;
		}
		if (t === 'error') {
			this.emit('error', new Error(msg.error && msg.error.message || 'unknown error'));
			return;
		}
		if (t === 'response.done') {
			this.emit('responseDone', msg.response);
			return;
		}

		// VAD / turn lifecycle
		if (t === 'input_audio_buffer.speech_started') { this.emit('turnStart'); return; }
		if (t === 'input_audio_buffer.speech_stopped') { this.emit('turnEnd');   return; }

		// User audio transcription (input transcript deltas)
		if (t === 'conversation.item.input_audio_transcription.delta'
		 || t === 'conversation.item.input_audio_transcription.completed') {
			this.emit('transcript', {
				role:    'user',
				text:    msg.delta || msg.transcript || '',
				isFinal: t.indexOf('completed') !== -1
			});
			return;
		}

		// Assistant transcript deltas
		if (t === 'response.audio_transcript.delta') {
			this.emit('transcript', { role: 'assistant', text: msg.delta || '', isFinal: false });
			return;
		}
		if (t === 'response.audio_transcript.done') {
			this.emit('transcript', { role: 'assistant', text: msg.transcript || '', isFinal: true });
			return;
		}

		// Assistant audio (WebSocket transport only — WebRTC audio goes via track)
		if (t === 'response.audio.delta' && msg.delta) {
			this.emit('audio', msg.delta);  // base64-encoded PCM16
			return;
		}

		// Tool calls
		if (t === 'response.function_call_arguments.done') {
			var args = {};
			try { args = JSON.parse(msg.arguments || '{}'); } catch (e) { args = {}; }
			this.emit('toolCall', {
				callId:    msg.call_id,
				name:      msg.name,
				arguments: args
			});
			return;
		}

		// Misc — surface as a generic 'event' if anyone cares
		// (intentionally not emitted to avoid noise; uncomment if needed)
		// this.emit('event', msg);
	};

	function _bufferToB64(buf) {
		var bytes = new Uint8Array(buf);
		var binary = '';
		var chunk = 0x8000;
		for (var i = 0; i < bytes.length; i += chunk) {
			binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
		}
		return btoa(binary);
	}

	// Register with the AI.Voice registry under both protocol names that
	// resolve to this implementation.
	if (Voice && Voice.registerProtocol) {
		Voice.registerProtocol('openai-realtime', OpenaiRealtime);
	}

	return OpenaiRealtime;
}));
