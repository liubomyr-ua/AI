<?php

/**
 * AI_Voice_Gemini — Google Gemini Live API broker.
 *
 * IMPORTANT — PROXY MODE ONLY.
 *
 * Gemini Live (as of May 2026) provides only server-to-server
 * authentication and is NOT recommended for direct client use. There
 * is no first-class ephemeral-token mechanism. So this adapter operates
 * in 'proxy' mode: the browser connects to YOUR server via WebSocket,
 * and YOUR server forwards messages to/from Gemini's WebSocket using
 * server-side auth.
 *
 * This means you need a small WebSocket proxy endpoint on your server
 * (not implemented here; outside the adapter's concern). The adapter's
 * job is:
 *   1. Issue a short-lived session ticket
 *   2. Return the proxy WebSocket URL the browser should connect to
 *   3. Stash the session config so the proxy can apply it on the
 *      outbound Gemini connection
 *
 * For a working proxy implementation, see Google's reference:
 *   https://github.com/google-gemini/gemini-live-api-examples
 *   (server.py + frontend/geminilive.js)
 *
 * Config:
 *   AI/gemini/apiKey       — required for AI Studio mode
 *   AI/gemini/proxyWsUrl   — required, e.g. wss://your-server.com/gemini-proxy
 *   AI/gemini/proxyTtl     — default 300 seconds
 *
 * Alternative: use AI_Voice_VertexAi (not implemented here, would route
 * through Vertex AI's Gemini Live endpoint with service-account auth).
 */
class AI_Voice_Gemini extends AI_Voice
{
	protected $apiKey;
	protected $proxyWsUrl;
	protected $proxyTtl;
	protected $defaults;

	function __construct($options = array())
	{
		$this->apiKey = isset($options['apiKey'])
			? $options['apiKey']
			: Q_Config::get(array('AI', 'gemini', 'apiKey'),
				Q_Config::get(array('AI', 'google', 'api_key'), null));
		$this->proxyWsUrl = isset($options['proxyWsUrl'])
			? $options['proxyWsUrl']
			: Q_Config::expect('AI', 'gemini', 'proxyWsUrl');
		$this->proxyTtl = isset($options['proxyTtl'])
			? (int)$options['proxyTtl']
			: (int)Q_Config::get(array('AI', 'gemini', 'proxyTtl'), 300);
		$this->defaults = $options;
	}

	public function getProtocol() { return 'gemini-live'; }

	public function createSession(array $params = array())
	{
		$cfg = array_replace($this->defaults, $params);
		$model = Q::ifset($cfg, 'model', 'gemini-2.5-flash-native-audio-preview-12-2025');

		// Generate a per-session ticket. The proxy server will validate
		// this and apply the stashed session config when establishing
		// the upstream WebSocket to Gemini.
		$ticket = bin2hex(random_bytes(16));
		$expiresAt = time() + $this->proxyTtl;

		// Setup payload per Gemini Live BidiGenerateContentSetup spec.
		// The proxy sends this as the FIRST message on the upstream WS.
		$setup = array(
			'setup' => array(
				'model'              => 'models/' . $model,
				'generationConfig'   => array(
					'responseModalities' => Q::ifset($cfg, 'responseModalities', array('AUDIO'))
				)
			)
		);
		if (isset($cfg['instructions'])) {
			$setup['setup']['systemInstruction'] = array(
				'parts' => array(array('text' => $cfg['instructions']))
			);
		}
		if (isset($cfg['tools'])) {
			$setup['setup']['tools'] = $cfg['tools'];
		}
		if (isset($cfg['turn_detection'])) {
			// Map common shape to Gemini-specific automaticActivityDetection.
			$setup['setup']['realtimeInputConfig'] = array(
				'automaticActivityDetection' => $cfg['turn_detection']
			);
		}

		// Stash setup config keyed by ticket, with TTL. The proxy reads
		// this on incoming client connection.
		//
		// NOTE: this uses Q_Cache as a simple store. In production you'd
		// probably want a Redis/Memcached backing or a dedicated session
		// store. The proxy must be able to read it.
		$cacheKey = 'AI/Voice/Gemini/session/' . $ticket;
		if (class_exists('Q_Cache')) {
			Q_Cache::set($cacheKey, array(
				'setup'      => $setup,
				'apiKey'     => $this->apiKey,  // for proxy to use upstream
				'expiresAt'  => $expiresAt,
				'model'      => $model
			), $this->proxyTtl);
		}

		// Return the proxy URL plus the ticket the browser should pass.
		$wsUrl = $this->proxyWsUrl;
		if (strpos($wsUrl, '?') === false) {
			$wsUrl .= '?ticket=' . urlencode($ticket);
		} else {
			$wsUrl .= '&ticket=' . urlencode($ticket);
		}

		return array(
			'token'     => $ticket,
			'wsUrl'     => $wsUrl,
			'wrtcUrl'   => null,
			'protocol'  => 'gemini-live',
			'model'     => $model,
			'expiresAt' => $expiresAt,
			'mode'      => 'proxy',
			'session'   => $setup
		);
	}
}
