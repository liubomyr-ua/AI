/**
 * AI.Voice.Pipecat — thin client for Pipecat gateway.
 *
 * Pipecat is your own self-hosted orchestrator (Python framework). The
 * "wire format" is whatever your Pipecat server exposes — Pipecat supports
 * multiple transports (Daily WebRTC, SmallWebRTCTransport, WebSocket
 * Server, LiveKit).
 *
 * This adapter assumes the WebSocket Server transport. For Daily WebRTC
 * or LiveKit, use those transport's own SDKs (or AI.Voice.LiveKit for
 * the LiveKit case).
 *
 * Wire format on Pipecat's WebSocket Server transport (default):
 *   - Binary frames: raw PCM audio (in and out)
 *   - JSON text frames: control events
 *
 * Pipecat is highly configurable so the event JSON shapes are up to your
 * deployment. This wrapper standardizes:
 *   - emits 'transcript' when the server sends { type: 'transcript', ... }
 *   - emits 'audio' when binary frames arrive (raw PCM, base64-encoded for
 *     the public API to match other adapters)
 *   - emits 'toolCall' when the server sends { type: 'toolCall', ... }
 *
 * Customize the event_name field on your Pipecat server processors to
 * match these conventions, or fork this adapter for your deployment.
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

	function Pipecat(session) {
		Emitter.call(this);
		this.session  = session;
		this.token    = session.token;
		this.wsUrl    = session.wsUrl;
		this._ws      = null;
		this._stream  = null;
		this._audioCtx = null;
		this._micWorklet = null;
	}
	Pipecat.prototype = Object.create(Emitter.prototype);
	Pipecat.prototype.constructor = Pipecat;

	Pipecat.prototype.connect = function () {
		var self = this;
		return new Promise(function (resolve, reject) {
			// Append token as query param if not already in URL
			var url = self.wsUrl;
			if (self.token && url.indexOf('token=') === -1) {
				url += (url.indexOf('?') !== -1 ? '&' : '?') + 'token=' + encodeURIComponent(self.token);
			}
			var ws;
			try { ws = new WebSocket(url); }
			catch (e) { return reject(e); }
			self._ws = ws;
			ws.binaryType = 'arraybuffer';

			ws.onopen = function () {
				self.emit('open');
				resolve();
			};
			ws.onmessage = function (e) {
				if (typeof e.data === 'string') {
					var msg;
					try { msg = JSON.parse(e.data); }
					catch (err) { return; }
					self._handleEvent(msg);
				} else {
					// Binary audio frame
					self.emit('audio', _bufferToB64(e.data));
				}
			};
			ws.onerror = function (err) {
				self.emit('error', err);
				if (!self._opened) reject(err);
			};
			ws.onclose = function () { self.emit('close'); };
		});
	};

	Pipecat.prototype.startMicrophone = function (constraints) {
		var self = this;
		if (typeof navigator === 'undefined' || !navigator.mediaDevices) {
			return Promise.reject(new Error('AI.Voice: navigator.mediaDevices unavailable'));
		}
		return navigator.mediaDevices.getUserMedia(constraints).then(function (stream) {
			self._stream = stream;
			// Pipecat WebSocket Server transport accepts raw PCM 16kHz by
			// default. Adjust here if your deployment uses different.
			var AudioCtx = window.AudioContext || window.webkitAudioContext;
			var ctx = new AudioCtx({ sampleRate: 16000 });
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
				if (self._ws && self._ws.readyState === WebSocket.OPEN) {
					self._ws.send(i16.buffer);  // binary frame
				}
			};
		});
	};

	Pipecat.prototype.stopMicrophone = function () {
		if (this._stream) {
			this._stream.getTracks().forEach(function (t) { t.stop(); });
			this._stream = null;
		}
		if (this._micWorklet) { try { this._micWorklet.disconnect(); } catch (e) {} this._micWorklet = null; }
		if (this._audioCtx)   { try { this._audioCtx.close();      } catch (e) {} this._audioCtx   = null; }
	};

	Pipecat.prototype.sendText = function (text, role) {
		this._send({ type: 'text', role: role || 'user', text: text });
	};

	Pipecat.prototype.respondToToolCall = function (callId, result) {
		this._send({ type: 'toolResponse', callId: callId, result: result });
	};

	Pipecat.prototype.createResponse = function () {
		this._send({ type: 'respond' });
	};

	Pipecat.prototype.cancelResponse = function () {
		this._send({ type: 'cancel' });
	};

	Pipecat.prototype.close = function () {
		this.stopMicrophone();
		if (this._ws) { try { this._ws.close(); } catch (e) {} this._ws = null; }
	};

	Pipecat.prototype._send = function (obj) {
		if (this._ws && this._ws.readyState === WebSocket.OPEN) {
			this._ws.send(JSON.stringify(obj));
		}
	};

	Pipecat.prototype._handleEvent = function (msg) {
		switch (msg.type) {
			case 'transcript':
				this.emit('transcript', {
					role:    msg.role || 'assistant',
					text:    msg.text || '',
					isFinal: !!msg.isFinal
				});
				break;
			case 'toolCall':
				this.emit('toolCall', {
					callId:    msg.callId,
					name:      msg.name,
					arguments: msg.arguments || {}
				});
				break;
			case 'turnStart': this.emit('turnStart'); break;
			case 'turnEnd':   this.emit('turnEnd');   break;
			case 'error':     this.emit('error', new Error(msg.message || 'pipecat error')); break;
			default: break;
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
		Voice.registerProtocol('pipecat', Pipecat);
	}
	return Pipecat;
}));
