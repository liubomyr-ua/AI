<?php

/**
 * AI/Voice — provider-agnostic realtime voice session brokering.
 *
 * Realtime voice is fundamentally different from batch LLM:
 *   - The audio flows over a persistent WebSocket or WebRTC connection
 *   - Browser/iframe clients connect DIRECTLY to the provider
 *   - Server's job is to issue ephemeral tokens that scope client access
 *
 * This base class and adapter pattern handle:
 *   1. Server-side ephemeral-token issuance (per provider)
 *   2. Returning client config so the browser knows how to connect
 *   3. Routing by deployment config (route name -> provider class)
 *
 * Browser-side: see web/js/AI/Voice.js for the unified client that
 * speaks each provider's session protocol.
 *
 * Usage from PHP:
 *   $broker = AI_Voice::route('conversational');
 *   $session = $broker->createSession(array(
 *       'voice'        => 'alloy',
 *       'instructions' => 'You are a helpful assistant.',
 *       'turn_detection' => array('type' => 'server_vad')
 *   ));
 *   // $session = ['token' => '...', 'wsUrl' => '...', 'protocol' => 'openai-realtime', 'expiresAt' => ...]
 *   // Return $session to the browser, which uses AI.Voice.connect(session).
 */
interface AI_Voice_Interface
{
	/**
	 * Issue an ephemeral session token + client connection info.
	 *
	 * The token is short-lived and bound to the session config. The
	 * browser uses it to connect directly to the provider, never seeing
	 * your API key.
	 *
	 * @param {array} $params  Session configuration:
	 *     voice:           string voice id (provider-specific)
	 *     instructions:    string system prompt for the agent
	 *     turn_detection:  array  VAD config (provider-specific shape)
	 *     tools:           array  function/MCP tool definitions
	 *     audioFormat:     string e.g. 'pcm16'
	 *     sampleRate:      number e.g. 24000
	 *     ttl:             number requested token lifetime seconds
	 *
	 * @return {array}
	 *     token:     string  ephemeral token to send to the client
	 *     wsUrl:     string  WebSocket URL for the client to connect to
	 *     wrtcUrl:   string|null   WebRTC SDP exchange URL (when supported)
	 *     protocol:  string  'openai-realtime' | 'gemini-live' | 'pipecat' | ...
	 *                        (drives client-side protocol dispatch)
	 *     model:     string  model name the session is bound to
	 *     expiresAt: number  unix timestamp when token expires
	 *     mode:      string  'direct' | 'proxy'
	 *                        ('proxy' means the client connects to YOUR
	 *                         server, which forwards to the provider —
	 *                         used when the provider doesn't issue
	 *                         client-safe tokens, e.g. Gemini Live)
	 */
	public function createSession(array $params = array());

	/**
	 * The protocol the JS client must speak to drive this session.
	 * Used to look up the correct AI.Voice.<Protocol> class browser-side.
	 *
	 * @return {string}  protocol identifier
	 */
	public function getProtocol();
}

/**
 * Base class. Concrete adapters in AI/Voice/<Provider>.php.
 */
abstract class AI_Voice implements AI_Voice_Interface
{
	abstract public function createSession(array $params = array());
	abstract public function getProtocol();

	/**
	 * Instantiate a voice adapter directly by name or class.
	 */
	public static function create($adapter, $options = array())
	{
		if (empty($adapter)) return null;
		if (is_object($adapter)) return $adapter;

		$sanitized = preg_replace('/[^a-z0-9]+/i', ' ', (string)$adapter);
		$suffix    = str_replace(' ', '', ucwords($sanitized));
		$className = "AI_Voice_{$suffix}";
		if (class_exists($className)) {
			return new $className($options);
		}
		return null;
	}

	/**
	 * Route to a voice adapter by deployment-configured route name.
	 *
	 * Resolves routeName via AI/voice/routes -> provider name, then
	 * looks up AI/voice/providers[providerName] = { class, config }.
	 *
	 * Config shape:
	 *   AI/voice/routes:    { routeName: providerName, ... }
	 *   AI/voice/providers: { providerName: { class, config }, ... }
	 *   AI/voice/default:   fallback providerName
	 */
	public static function route($routeName, array $options = array())
	{
		$routes    = Q_Config::get(array('AI', 'voice', 'routes'),    array());
		$providers = Q_Config::get(array('AI', 'voice', 'providers'), array());
		$default   = Q_Config::get(array('AI', 'voice', 'default'),   null);

		$providerName = null;
		if (is_array($routes) && isset($routes[$routeName])) {
			$providerName = $routes[$routeName];
		} elseif ($default) {
			$providerName = $default;
		} elseif (is_array($providers) && !empty($providers)) {
			$names = array_keys($providers);
			$providerName = reset($names);
		}
		if (!$providerName) return null;

		$providerDef = is_array($providers) ? Q::ifset($providers, $providerName, null) : null;
		if (!$providerDef) {
			return self::create($providerName, $options);
		}
		$className = isset($providerDef['class']) ? $providerDef['class'] : null;
		if (!$className) return null;

		$mergedOptions = array();
		if (isset($providerDef['config']) && is_array($providerDef['config'])) {
			$mergedOptions = $providerDef['config'];
		}
		$mergedOptions = array_replace($mergedOptions, $options);

		return self::create($className, $mergedOptions);
	}

	public static function listRoutes()
	{
		$routes = Q_Config::get(array('AI', 'voice', 'routes'), array());
		return is_array($routes) ? array_keys($routes) : array();
	}

	public static function listProviders()
	{
		$providers = Q_Config::get(array('AI', 'voice', 'providers'), array());
		return is_array($providers) ? array_keys($providers) : array();
	}
}
