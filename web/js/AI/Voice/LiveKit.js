/**
 * AI.Voice.LiveKit — thin shim around the LiveKit client SDK.
 *
 * Unlike the other adapters, this one doesn't implement the wire protocol
 * itself — LiveKit has its own well-maintained client SDK (livekit-client),
 * and reimplementing it would be wasteful and brittle.
 *
 * Usage:
 *   1. Load the LiveKit client SDK in your page:
 *        <script src="https://unpkg.com/livekit-client/dist/livekit-client.umd.min.js"></script>
 *      Or import it as an ES module.
 *
 *   2. AI.Voice.LiveKit detects window.LivekitClient (UMD) or accepts an
 *      injected SDK reference via options.
 *
 *   3. Server-side AI_Voice_Local with subtype='livekit' issues a token;
 *      this client uses it to connect to your LiveKit server.
 *
 * If livekit-client isn't loaded, this adapter throws on connect() with
 * a clear message pointing at the SDK.
 *
 * Why this approach: LiveKit's protocol involves WebRTC SFU semantics
 * (room participants, track subscriptions, ICE candidates), which the
 * official SDK handles correctly. Building a hand-rolled adapter would
 * be a quagmire of subtle bugs.
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

	function LiveKit(session) {
		Emitter.call(this);
		this.session = session;
		this.token   = session.token;
		this.wsUrl   = session.wsUrl;
		this.room    = null;
	}
	LiveKit.prototype = Object.create(Emitter.prototype);
	LiveKit.prototype.constructor = LiveKit;

	LiveKit.prototype._getSdk = function () {
		// Allow injection via constructor for ES module use
		if (this.session._livekitSdk) return this.session._livekitSdk;
		// UMD global
		if (typeof window !== 'undefined' && window.LivekitClient) return window.LivekitClient;
		if (typeof LivekitClient !== 'undefined') return LivekitClient;
		throw new Error('AI.Voice.LiveKit: livekit-client SDK not loaded. '
			+ 'Add <script src="https://unpkg.com/livekit-client"></script> '
			+ 'or pass _livekitSdk in session config.');
	};

	LiveKit.prototype.connect = function () {
		var self = this;
		var Sdk;
		try { Sdk = this._getSdk(); } catch (e) { return Promise.reject(e); }

		var room = new Sdk.Room({
			adaptiveStream: true,
			dynacast:       true
		});
		this.room = room;

		// Track incoming audio tracks from agent participants.
		room.on(Sdk.RoomEvent.TrackSubscribed, function (track, publication, participant) {
			if (track.kind === 'audio') {
				var audio = track.attach();
				audio.autoplay = true;
				self._modelAudioEl = audio;
			}
		});

		// Data channel events for transcripts and tool calls (assuming the
		// agent publishes them as DataPackets with JSON payloads).
		room.on(Sdk.RoomEvent.DataReceived, function (payload, participant) {
			var decoded;
			try {
				decoded = JSON.parse(new TextDecoder().decode(payload));
			} catch (e) { return; }
			if (decoded.type === 'transcript') {
				self.emit('transcript', decoded);
			} else if (decoded.type === 'toolCall') {
				self.emit('toolCall', decoded);
			} else if (decoded.type === 'turnStart') {
				self.emit('turnStart');
			} else if (decoded.type === 'turnEnd') {
				self.emit('turnEnd');
			}
		});

		room.on(Sdk.RoomEvent.Disconnected, function () { self.emit('close'); });

		return room.connect(this.wsUrl, this.token).then(function () {
			self.emit('open');
		});
	};

	LiveKit.prototype.startMicrophone = function () {
		if (!this.room) return Promise.reject(new Error('AI.Voice.LiveKit: not connected'));
		return this.room.localParticipant.setMicrophoneEnabled(true);
	};

	LiveKit.prototype.stopMicrophone = function () {
		if (!this.room) return;
		this.room.localParticipant.setMicrophoneEnabled(false);
	};

	LiveKit.prototype.sendText = function (text, role) {
		var payload = new TextEncoder().encode(JSON.stringify({
			type: 'text', role: role || 'user', text: text
		}));
		if (this.room) this.room.localParticipant.publishData(payload, { reliable: true });
	};

	LiveKit.prototype.respondToToolCall = function (callId, result) {
		var payload = new TextEncoder().encode(JSON.stringify({
			type: 'toolResponse', callId: callId, result: result
		}));
		if (this.room) this.room.localParticipant.publishData(payload, { reliable: true });
	};

	LiveKit.prototype.createResponse = function () {
		// Most LiveKit agents auto-respond on turn boundary.
		var payload = new TextEncoder().encode(JSON.stringify({ type: 'respond' }));
		if (this.room) this.room.localParticipant.publishData(payload, { reliable: true });
	};

	LiveKit.prototype.cancelResponse = function () {
		var payload = new TextEncoder().encode(JSON.stringify({ type: 'cancel' }));
		if (this.room) this.room.localParticipant.publishData(payload, { reliable: true });
	};

	LiveKit.prototype.close = function () {
		if (this.room) { try { this.room.disconnect(); } catch (e) {} this.room = null; }
	};

	if (Voice && Voice.registerProtocol) {
		Voice.registerProtocol('livekit', LiveKit);
	}
	return LiveKit;
}));
