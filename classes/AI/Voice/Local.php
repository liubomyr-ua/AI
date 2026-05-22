<?php

/**
 * AI_Voice_Local — local voice gateway (Pipecat / LiveKit Agents).
 *
 * For self-hosted realtime voice, the "provider" is your own Pipecat or
 * LiveKit Agents server. This adapter doesn't speak to a hosted API at
 * all — it just provisions a session URL + auth token your local
 * orchestrator accepts.
 *
 * Two common patterns:
 *
 * 1. PIPECAT (Daily WebRTC or WebSocket transport)
 *    Your Pipecat server runs at some URL. The adapter mints a session
 *    token (HMAC-signed JWT with TTL + room/agent metadata) and returns
 *    the WS URL. Your Pipecat server validates the token on connect.
 *
 * 2. LIVEKIT (WebRTC SFU)
 *    LiveKit uses its own JWT-based room tokens. The adapter signs a
 *    token with the LiveKit API key/secret and returns it plus the
 *    LiveKit server URL. The browser then uses the standard LiveKit
 *    client SDK with the token.
 *
 * Subtype selection drives which scheme the adapter uses:
 *
 * Config:
 *   AI/voiceLocal/subtype       — 'pipecat' | 'livekit'
 *   AI/voiceLocal/url           — wss://your-gateway:7860/ (pipecat) or
 *                                 wss://your-livekit-server (livekit)
 *   AI/voiceLocal/secret        — HMAC secret for pipecat tokens
 *   AI/voiceLocal/livekitKey    — LiveKit API key
 *   AI/voiceLocal/livekitSecret — LiveKit API secret
 *   AI/voiceLocal/ttl           — token lifetime seconds (default 600)
 *   AI/voiceLocal/allowedHosts  — SSRF whitelist
 *
 * The actual STT + LLM + TTS pipeline lives inside your Pipecat or
 * LiveKit Agents server; this adapter doesn't configure it directly.
 * Pass agent-specific config through `params['agentConfig']` and your
 * gateway code can read it from the JWT payload.
 */
class AI_Voice_Local extends AI_Voice
{
	protected $subtype;
	protected $url;
	protected $secret;
	protected $livekitKey;
	protected $livekitSecret;
	protected $ttl;
	protected $defaults;

	function __construct($options = array())
	{
		$this->subtype = isset($options['subtype'])
			? $options['subtype']
			: Q_Config::get(array('AI', 'voiceLocal', 'subtype'), 'pipecat');
		$this->url = isset($options['url'])
			? $options['url']
			: Q_Config::expect('AI', 'voiceLocal', 'url');
		$this->secret        = Q_Config::get(array('AI', 'voiceLocal', 'secret'), '');
		$this->livekitKey    = Q_Config::get(array('AI', 'voiceLocal', 'livekitKey'), '');
		$this->livekitSecret = Q_Config::get(array('AI', 'voiceLocal', 'livekitSecret'), '');
		$this->ttl = isset($options['ttl'])
			? (int)$options['ttl']
			: (int)Q_Config::get(array('AI', 'voiceLocal', 'ttl'), 600);
		$this->defaults = $options;

		$this->_validateHost($this->url);
	}

	public function getProtocol()
	{
		return ($this->subtype === 'livekit') ? 'livekit' : 'pipecat';
	}

	public function createSession(array $params = array())
	{
		$cfg = array_replace($this->defaults, $params);
		$expiresAt = time() + $this->ttl;

		if ($this->subtype === 'livekit') {
			return $this->_createLivekitSession($cfg, $expiresAt);
		}
		return $this->_createPipecatSession($cfg, $expiresAt);
	}

	protected function _createPipecatSession(array $cfg, $expiresAt)
	{
		if (!$this->secret) {
			throw new Exception('AI_Voice_Local: AI/voiceLocal/secret required for pipecat tokens');
		}
		$payload = array(
			'iat'   => time(),
			'exp'   => $expiresAt,
			'agent' => Q::ifset($cfg, 'agent', 'default'),
			'config' => Q::ifset($cfg, 'agentConfig', array())
		);
		$token = $this->_signJwt($payload, $this->secret);

		return array(
			'token'     => $token,
			'wsUrl'     => $this->url,
			'wrtcUrl'   => null,  // Pipecat WebRTC negotiates via the server-side Daily/SmallWebRTC adapter
			'protocol'  => 'pipecat',
			'model'     => Q::ifset($cfg, 'agent', 'default'),
			'expiresAt' => $expiresAt,
			'mode'      => 'direct',
			'session'   => $payload
		);
	}

	protected function _createLivekitSession(array $cfg, $expiresAt)
	{
		if (!$this->livekitKey || !$this->livekitSecret) {
			throw new Exception('AI_Voice_Local: AI/voiceLocal/livekitKey + livekitSecret required for livekit tokens');
		}
		$identity = Q::ifset($cfg, 'identity', 'user_' . bin2hex(random_bytes(8)));
		$room     = Q::ifset($cfg, 'room',     'agent_' . bin2hex(random_bytes(8)));

		$payload = array(
			'iss' => $this->livekitKey,
			'sub' => $identity,
			'iat' => time(),
			'exp' => $expiresAt,
			'nbf' => time(),
			'video' => array(
				'room'        => $room,
				'roomJoin'    => true,
				'canPublish'  => true,
				'canSubscribe'=> true
			)
		);
		if (!empty($cfg['agentConfig'])) {
			$payload['metadata'] = json_encode($cfg['agentConfig']);
		}
		$token = $this->_signJwt($payload, $this->livekitSecret);

		return array(
			'token'     => $token,
			'wsUrl'     => $this->url,
			'wrtcUrl'   => $this->url, // LiveKit JS SDK negotiates WebRTC via this URL
			'protocol'  => 'livekit',
			'model'     => Q::ifset($cfg, 'agent', 'default'),
			'expiresAt' => $expiresAt,
			'mode'      => 'direct',
			'session'   => array('room' => $room, 'identity' => $identity)
		);
	}

	/**
	 * Sign a HS256 JWT. Minimal implementation; no external dep.
	 */
	protected function _signJwt(array $payload, $secret)
	{
		$header  = $this->_b64u(json_encode(array('alg' => 'HS256', 'typ' => 'JWT')));
		$body    = $this->_b64u(json_encode($payload));
		$signing = $header . '.' . $body;
		$sig     = $this->_b64u(hash_hmac('sha256', $signing, $secret, true));
		return $signing . '.' . $sig;
	}

	protected function _b64u($data)
	{
		return rtrim(strtr(base64_encode($data), '+/', '-_'), '=');
	}

	protected function _validateHost($url)
	{
		$allowed = Q_Config::get(array('AI', 'voiceLocal', 'allowedHosts'),
			array('localhost', '127.0.0.1', '::1'));
		// Strip ws:// or wss:// prefix for host parse.
		$normalized = preg_replace('#^wss?://#', 'https://', $url);
		$parsed = parse_url($normalized);
		if (!$parsed || empty($parsed['host'])) {
			throw new Exception('AI_Voice_Local: invalid url: ' . $url);
		}
		$host = strtolower($parsed['host']);
		$allowedLower = array_map('strtolower', $allowed);
		if (!in_array($host, $allowedLower, true)) {
			throw new Exception(
				'AI_Voice_Local: host "' . $host . '" not in AI/voiceLocal/allowedHosts. '
				. 'Add it to whitelist to allow this gateway.');
		}
	}
}
