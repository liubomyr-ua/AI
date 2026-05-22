/**
 * AI.Voice — unified browser/iframe client for realtime voice sessions.
 *
 * Usage:
 *   // 1. Server issues a session via AI_Voice::route('conversational')->createSession(...)
 *   //    The server returns the JSON object to the browser.
 *
 *   // 2. Browser code:
 *   var session = await fetch('/api/voice/session', { method: 'POST' }).then(r => r.json());
 *   var voice = new AI.Voice(session);
 *
 *   voice.on('audio', function (audioChunk) { ... play it ... });
 *   voice.on('transcript', function (event) {
 *     // event.role: 'user' | 'assistant'
 *     // event.text: string (delta)
 *     // event.isFinal: boolean
 *   });
 *   voice.on('toolCall', function (call) { ... handle call.name, call.arguments ... });
 *   voice.on('error', function (err) { ... });
 *   voice.on('open',  function () { ... session ready ... });
 *   voice.on('close', function () { ... });
 *
 *   await voice.connect();
 *   await voice.startMicrophone();   // browser captures audio and forwards
 *   // ... user talks ...
 *   voice.sendText('Hello?');         // optionally inject text mid-session
 *   voice.respondToToolCall(callId, result);  // after handling a toolCall
 *   voice.close();
 *
 * The session object from the server tells AI.Voice which protocol class
 * to instantiate (openai-realtime, gemini-live, pipecat, livekit).
 *
 * IFRAME / postMessage SUPPORT:
 *   AI.Voice.attachPostMessageBridge(window.parent)
 *   makes a parent page able to drive the voice session in this iframe:
 *
 *     // Parent page:
 *     iframe.contentWindow.postMessage({type:'voice.connect', session: ...}, '*');
 *     window.addEventListener('message', e => {
 *       if (e.data.type === 'voice.transcript') console.log(e.data.text);
 *     });
 *
 *   See the bridge implementation at the bottom of this file.
 */
(function (root, factory) {
	if (typeof module === 'object' && module.exports) {
		module.exports = factory();
	} else {
		root.AI = root.AI || {};
		root.AI.Voice = factory();
	}
}(typeof self !== 'undefined' ? self : this, function () {
	'use strict';

	// Tiny EventEmitter so we can run in browser or Node.
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
	Emitter.prototype.emit = function (ev /*, args... */) {
		var args = Array.prototype.slice.call(arguments, 1);
		(this._listeners[ev] || []).forEach(function (fn) {
			try { fn.apply(null, args); } catch (e) { /* swallow listener errors */ }
		});
	};

	// Registry of protocol classes. Populated by AI.Voice.<Protocol>.js
	// files that load after this one and call AI.Voice.registerProtocol().
	var protocols = {};

	function Voice(session) {
		if (!(this instanceof Voice)) return new Voice(session);
		Emitter.call(this);
		this.session = session;
		this.protocolName = session && session.protocol;
		this._impl = null;
		this._connected = false;
	}
	Voice.prototype = Object.create(Emitter.prototype);
	Voice.prototype.constructor = Voice;

	Voice.registerProtocol = function (name, cls) {
		protocols[name] = cls;
	};
	Voice.listProtocols = function () {
		return Object.keys(protocols);
	};

	/**
	 * Establish the session connection. Returns a Promise that resolves
	 * when the session is open (after session.update ack on OpenAI-style,
	 * setupComplete on Gemini).
	 */
	Voice.prototype.connect = function () {
		var self = this;
		if (!this.protocolName) {
			return Promise.reject(new Error('AI.Voice: session.protocol missing'));
		}
		var Cls = protocols[this.protocolName];
		if (!Cls) {
			return Promise.reject(new Error('AI.Voice: protocol "' + this.protocolName
				+ '" not registered. Registered: ' + Object.keys(protocols).join(', ')));
		}
		this._impl = new Cls(this.session);

		// Bridge events from the protocol impl to our public emitter.
		['open', 'close', 'error', 'audio', 'transcript', 'toolCall',
		 'turnStart', 'turnEnd', 'sessionUpdated'].forEach(function (evt) {
			self._impl.on(evt, function () {
				var args = [evt].concat(Array.prototype.slice.call(arguments));
				self.emit.apply(self, args);
			});
		});

		return this._impl.connect().then(function () {
			self._connected = true;
		});
	};

	/**
	 * Start capturing microphone audio and forwarding to the session.
	 * Returns a Promise that resolves when the audio capture is running.
	 */
	Voice.prototype.startMicrophone = function (constraints) {
		if (!this._impl) return Promise.reject(new Error('AI.Voice: not connected'));
		return this._impl.startMicrophone(constraints || { audio: true });
	};

	Voice.prototype.stopMicrophone = function () {
		if (!this._impl) return;
		this._impl.stopMicrophone();
	};

	/**
	 * Inject a text message into the conversation (e.g. as a user turn).
	 */
	Voice.prototype.sendText = function (text, role) {
		if (!this._impl) throw new Error('AI.Voice: not connected');
		return this._impl.sendText(text, role || 'user');
	};

	/**
	 * Respond to a tool call from the model.
	 */
	Voice.prototype.respondToToolCall = function (callId, result) {
		if (!this._impl) throw new Error('AI.Voice: not connected');
		return this._impl.respondToToolCall(callId, result);
	};

	/**
	 * Request the model produce a response. Most providers do this
	 * automatically on user-turn end; needed only when the session is
	 * configured with turn_detection=null (manual turn control).
	 */
	Voice.prototype.createResponse = function (options) {
		if (!this._impl) throw new Error('AI.Voice: not connected');
		return this._impl.createResponse(options || {});
	};

	/**
	 * Interrupt the model mid-response (barge-in). Useful when the user
	 * starts talking and you want to cancel any in-progress assistant audio.
	 */
	Voice.prototype.cancelResponse = function () {
		if (!this._impl) return;
		return this._impl.cancelResponse();
	};

	Voice.prototype.close = function () {
		if (this._impl) this._impl.close();
		this._connected = false;
	};

	/**
	 * postMessage bridge for iframe use.
	 *
	 * When called, listens for postMessage events from `targetWindow`
	 * (typically window.parent) and translates them into AI.Voice
	 * operations. Sends events back via targetWindow.postMessage.
	 *
	 * Parent → iframe messages:
	 *   { type: 'voice.connect',           session: {...} }
	 *   { type: 'voice.startMic' }
	 *   { type: 'voice.stopMic' }
	 *   { type: 'voice.sendText',          text, role }
	 *   { type: 'voice.respondToToolCall', callId, result }
	 *   { type: 'voice.createResponse',    options }
	 *   { type: 'voice.cancelResponse' }
	 *   { type: 'voice.close' }
	 *
	 * Iframe → parent messages:
	 *   { type: 'voice.open' }
	 *   { type: 'voice.close' }
	 *   { type: 'voice.error',      message }
	 *   { type: 'voice.audio',      data:base64 }
	 *   { type: 'voice.transcript', role, text, isFinal }
	 *   { type: 'voice.toolCall',   callId, name, arguments }
	 *   { type: 'voice.turnStart' }
	 *   { type: 'voice.turnEnd' }
	 */
	Voice.attachPostMessageBridge = function (targetWindow, allowedOrigin) {
		var current = null;

		function post(type, payload) {
			var msg = Object.assign({ type: type }, payload || {});
			try {
				targetWindow.postMessage(msg, allowedOrigin || '*');
			} catch (e) { /* swallow */ }
		}

		function ensure() {
			if (!current) throw new Error('AI.Voice: no session connected via bridge');
			return current;
		}

		window.addEventListener('message', function (e) {
			if (allowedOrigin && e.origin !== allowedOrigin) return;
			var d = e.data || {};
			if (!d.type || d.type.indexOf('voice.') !== 0) return;

			try {
				switch (d.type) {
					case 'voice.connect':
						current = new Voice(d.session);
						current.on('open',        function ()  { post('voice.open'); });
						current.on('close',       function ()  { post('voice.close'); });
						current.on('error',       function (e) { post('voice.error',
							{ message: e && e.message || String(e) }); });
						current.on('audio',       function (a) { post('voice.audio',
							{ data: a }); });
						current.on('transcript',  function (t) { post('voice.transcript', t); });
						current.on('toolCall',    function (c) { post('voice.toolCall', c); });
						current.on('turnStart',   function ()  { post('voice.turnStart'); });
						current.on('turnEnd',     function ()  { post('voice.turnEnd'); });
						current.connect().catch(function (err) {
							post('voice.error', { message: err.message });
						});
						break;
					case 'voice.startMic':
						ensure().startMicrophone(d.constraints).catch(function (err) {
							post('voice.error', { message: err.message });
						});
						break;
					case 'voice.stopMic':           ensure().stopMicrophone(); break;
					case 'voice.sendText':         ensure().sendText(d.text, d.role); break;
					case 'voice.respondToToolCall':ensure().respondToToolCall(d.callId, d.result); break;
					case 'voice.createResponse':   ensure().createResponse(d.options); break;
					case 'voice.cancelResponse':   ensure().cancelResponse(); break;
					case 'voice.close':
						if (current) { current.close(); current = null; }
						break;
				}
			} catch (err) {
				post('voice.error', { message: err.message });
			}
		});
	};

	return Voice;
}));
