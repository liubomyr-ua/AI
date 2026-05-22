/**
 * AI.Voice.GeminiLive — Google Gemini Live API protocol client.
 *
 * Connects via WebSocket. Note that the server-side adapter
 * (AI_Voice_Gemini.php) uses PROXY MODE — the client connects to
 * YOUR proxy, not directly to Google. The proxy forwards
 * setup/realtimeInput/etc. to Gemini.
 *
 * Wire format differs significantly from OpenAI Realtime:
 *
 *   Client → Server:
 *     { setup: { model, generationConfig, systemInstruction, tools } }
 *     { clientContent: { turns: [{ role, parts: [{ text }]}], turnComplete }}
 *     { realtimeInput: { audio: { data: b64, mimeType: 'audio/pcm;rate=16000' }}}
 *     { realtimeInput: { mediaChunks: [...] }}
 *     { toolResponse: { functionResponses: [...] }}
 *
 *   Server → Client:
 *     { setupComplete: {} }
 *     { serverContent: { modelTurn: { parts: [{ inlineData|text }]}, turnComplete }}
 *     { serverContent: { inputTranscription: { text }}}
 *     { serverContent: { outputTranscription: { text }}}
 *     { toolCall: { functionCalls: [...] }}
 *     { sessionResumptionUpdate: { ... }}
 *
 * Gemini Live uses 16kHz input audio (not 24kHz) per the spec.
 */
(function (root, factory) {
	if (typeof module === 'object' && module.exports) {
		module.exports = factory(require('./Voice'));
	} else {
		factory(root.AI.Voice);
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

	function GeminiLive(session) {
		Emitter.call(this);
		this.session = session;
		this.token = session.token;  // proxy ticket
		this.wsUrl = session.wsUrl;
		this._ws = null;
		this._stream = null;
		this._audioCtx = null;
		this._micWorklet = null;
		this._setupComplete = false;
		// Gemini wants 16kHz PCM input (per docs); output is typically 24kHz.
		this._inputSampleRate = 16000;
	}
	GeminiLive.prototype = Object.create(Emitter.prototype);
	GeminiLive.prototype.constructor = GeminiLive;

	GeminiLive.prototype.connect = function () {
		var self = this;
		return new Promise(function (resolve, reject) {
			var ws;
			try { ws = new WebSocket(self.wsUrl); }
			catch (e) { return reject(e); }
			self._ws = ws;

			ws.onopen = function () {
				// Send setup as first message. The proxy/server may also
				// pre-inject this from the stashed config — sending it
				// from the client makes it work without a smart proxy too.
				if (self.session.session) {
					ws.send(JSON.stringify(self.session.session));
				}
			};
			ws.onmessage = function (e) {
				var msg;
				try { msg = JSON.parse(typeof e.data === 'string' ? e.data : ''); }
				catch (err) { return; }
				if (msg.setupComplete) {
					self._setupComplete = true;
					self.emit('open');
					return resolve();
				}
				self._handleEvent(msg);
			};
			ws.onerror = function (err) {
				self.emit('error', err);
				if (!self._setupComplete) reject(err);
			};
			ws.onclose = function () { self.emit('close'); };
		});
	};

	GeminiLive.prototype.startMicrophone = function (constraints) {
		var self = this;
		if (typeof navigator === 'undefined' || !navigator.mediaDevices) {
			return Promise.reject(new Error('AI.Voice: navigator.mediaDevices unavailable'));
		}
		return navigator.mediaDevices.getUserMedia(constraints).then(function (stream) {
			self._stream = stream;
			self._streamPcmOverWs(stream);
		});
	};

	GeminiLive.prototype._streamPcmOverWs = function (stream) {
		var self = this;
		var AudioCtx = window.AudioContext || window.webkitAudioContext;
		var ctx = new AudioCtx({ sampleRate: self._inputSampleRate });
		self._audioCtx = ctx;
		var source = ctx.createMediaStreamSource(stream);
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
					realtimeInput: {
						audio: {
							data:     b64,
							mimeType: 'audio/pcm;rate=' + self._inputSampleRate
						}
					}
				}));
			}
		};
	};

	GeminiLive.prototype.stopMicrophone = function () {
		if (this._stream) {
			this._stream.getTracks().forEach(function (t) { t.stop(); });
			this._stream = null;
		}
		if (this._micWorklet) { try { this._micWorklet.disconnect(); } catch (e) {} this._micWorklet = null; }
		if (this._audioCtx)   { try { this._audioCtx.close();      } catch (e) {} this._audioCtx   = null; }
	};

	GeminiLive.prototype.sendText = function (text, role) {
		this._send({
			clientContent: {
				turns: [{ role: role || 'user', parts: [{ text: text }] }],
				turnComplete: true
			}
		});
	};

	GeminiLive.prototype.respondToToolCall = function (callId, result) {
		this._send({
			toolResponse: {
				functionResponses: [{
					id:       callId,
					response: typeof result === 'object' ? result : { result: result }
				}]
			}
		});
	};

	GeminiLive.prototype.createResponse = function () {
		// Gemini Live derives turn completion from user activity; explicit
		// trigger isn't part of the wire format. If a manual trigger is
		// needed, send an empty clientContent with turnComplete=true.
		this._send({ clientContent: { turns: [], turnComplete: true } });
	};

	GeminiLive.prototype.cancelResponse = function () {
		// Gemini interrupts via new realtimeInput; sending an empty audio
		// stream-end signal flushes the current generation.
		// There's no explicit cancel; the closest is sending another
		// realtimeInput which Gemini may interpret as barge-in depending on
		// turn_detection config.
		this._send({ realtimeInput: { audioStreamEnd: true } });
	};

	GeminiLive.prototype.close = function () {
		this.stopMicrophone();
		if (this._ws) { try { this._ws.close(); } catch (e) {} this._ws = null; }
	};

	GeminiLive.prototype._send = function (obj) {
		if (this._ws && this._ws.readyState === WebSocket.OPEN) {
			this._ws.send(JSON.stringify(obj));
		} else {
			this.emit('error', new Error('AI.Voice.GeminiLive: no open channel'));
		}
	};

	GeminiLive.prototype._handleEvent = function (msg) {
		// serverContent
		if (msg.serverContent) {
			var sc = msg.serverContent;
			// Input transcription
			if (sc.inputTranscription && sc.inputTranscription.text) {
				this.emit('transcript', {
					role: 'user',
					text: sc.inputTranscription.text,
					isFinal: false
				});
			}
			// Output transcription
			if (sc.outputTranscription && sc.outputTranscription.text) {
				this.emit('transcript', {
					role: 'assistant',
					text: sc.outputTranscription.text,
					isFinal: false
				});
			}
			// Model turn parts (audio or text)
			if (sc.modelTurn && sc.modelTurn.parts) {
				for (var i = 0; i < sc.modelTurn.parts.length; i++) {
					var part = sc.modelTurn.parts[i];
					if (part.inlineData && part.inlineData.data) {
						this.emit('audio', part.inlineData.data);
					}
					if (part.text) {
						this.emit('transcript', {
							role: 'assistant', text: part.text, isFinal: false
						});
					}
				}
			}
			// Turn complete signal
			if (sc.turnComplete) {
				this.emit('turnEnd');
			}
			return;
		}

		// toolCall (function call invocation)
		if (msg.toolCall && msg.toolCall.functionCalls) {
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

		// goAway: server-initiated disconnect warning
		if (msg.goAway) {
			this.emit('error', new Error('AI.Voice.GeminiLive: server going away: '
				+ (msg.goAway.timeLeft || 'unknown')));
			return;
		}
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

	if (Voice && Voice.registerProtocol) {
		Voice.registerProtocol('gemini-live', GeminiLive);
	}

	return GeminiLive;
}));
