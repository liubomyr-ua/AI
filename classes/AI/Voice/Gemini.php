<?php

/**
 * AI_Voice_Gemini — Google Gemini Live API broker.
 *
 * Issues an ephemeral auth token via POST /v1beta/auth_tokens. The browser
 * then connects DIRECTLY to Gemini's Live API WebSocket using that token --
 * no server-side proxy needed. (An earlier version of this adapter assumed
 * Gemini Live only supported server-to-server auth and required a full
 * WebSocket relay; Google added ephemeral tokens for the Live API since
 * then, so the direct-client model used by AI_Voice_Openai applies here
 * too now.)
 *
 * Wire protocol: BidiGenerateContent over a single stateful WebSocket (no
 * WebRTC transport, unlike OpenAI) -- see AI/web/js/AI/Voice/GeminiLive.js.
 *
 * Config:
 *   AI/gemini/apiKey  or  AI/google/api_key  — required (server-side API key,
 *     used only to mint the ephemeral token -- never sent to the browser)
 *   AI/gemini/realTime/model  — default 'gemini-3.1-flash-live-preview'
 *     (override per-call with $params['model'] if needed)
 *
 * No tracing/observability config yet: Gemini Live's equivalent (if any) to
 * OpenAI Realtime's session-level "tracing" hasn't been researched.
 *
 * Per-call options accepted by createSession (same shape AI_Voice_Openai
 * accepts, so AI/handlers/AI/voice/post.php doesn't need to know which
 * provider is active):
 *   model, instructions, tools (OpenAI-JSON-Schema-shaped function defs --
 *   translated to Gemini's functionDeclarations shape internally), voice,
 *   turn_detection (any non-null value -> manual/activityStart+End mode,
 *   matching how post.php always passes null here), input_audio_transcription,
 *   modalities (['text'] -> responseModalities:['TEXT']), webSearch (true ->
 *   adds the googleSearch tool -- Gemini-specific; OpenAI's adapter has no
 *   equivalent and just ignores this key).
 */
class AI_Voice_Gemini extends AI_Voice
{
	protected $apiKey;
	protected $baseUrl;
	protected $defaults;

	function __construct($options = array())
	{
		$this->apiKey = isset($options['apiKey'])
			? $options['apiKey']
			: Q_Config::get('AI', 'gemini', 'apiKey',
				Q_Config::get('AI', 'google', 'api_key', null));
		if (!$this->apiKey) {
			throw new Exception('AI_Voice_Gemini: apiKey required (AI/gemini/apiKey or AI/google/api_key)');
		}
		$this->baseUrl = rtrim(isset($options['baseUrl'])
			? $options['baseUrl']
			: Q_Config::get('AI', 'gemini', 'baseUrl', 'https://generativelanguage.googleapis.com'), '/');
		$this->defaults = $options;
	}

	public function getProtocol() { return 'gemini-live'; }

	/**
	 * Translate one OpenAI-JSON-Schema-shaped function tool (as built by
	 * AI/handlers/AI/voice/post.php, shared with AI_Voice_Openai) into
	 * Gemini's functionDeclarations shape:
	 *   - drops the {type:'function', ...} wrapper (Gemini's array is
	 *     functionDeclarations directly, no per-entry "type" discriminator)
	 *   - JSON-Schema `type` values become Gemini's uppercase Schema.Type
	 *     enum (STRING, NUMBER, OBJECT, ARRAY, ...)
	 *   - a JSON-Schema union `["string","null"]` becomes a single uppercase
	 *     `type` plus `nullable:true` (Gemini's Schema has no union type)
	 * @private
	 */
	protected function _translateFunctionTool(array $tool)
	{
		return array(
			'name'        => Q::ifset($tool, 'name', ''),
			'description' => Q::ifset($tool, 'description', ''),
			'parameters'  => $this->_translateSchema(Q::ifset($tool, 'parameters', array()))
		);
	}

	/** @private */
	protected function _translateSchema($schema)
	{
		if (!is_array($schema)) return $schema;

		$out = array();
		$type = Q::ifset($schema, 'type', null);
		$nullable = false;
		if (is_array($type)) {
			// e.g. ['string', 'null'] -> STRING + nullable:true
			$nonNull = array_values(array_diff($type, array('null')));
			$nullable = (count($nonNull) < count($type));
			$type = Q::ifset($nonNull, 0, 'string');
		}
		if ($type !== null) $out['type'] = strtoupper($type);
		if ($nullable) $out['nullable'] = true;

		if (isset($schema['description'])) $out['description'] = $schema['description'];
		if (isset($schema['enum'])) {
			// Gemini's enum is string-only and non-nullable; a literal null
			// sentinel in an OpenAI-style enum has no equivalent -- drop it
			// and mark the field nullable instead (matches the ['string',
			// 'null'] handling above, which is how post.php models "or null").
			$out['enum'] = array_values(array_filter($schema['enum'], function ($v) {
				return $v !== null;
			}));
			if (count($out['enum']) < count($schema['enum'])) $out['nullable'] = true;
		}
		if (isset($schema['required'])) $out['required'] = $schema['required'];
		if (isset($schema['properties'])) {
			$props = array();
			foreach ($schema['properties'] as $pname => $pspec) {
				$props[$pname] = $this->_translateSchema($pspec);
			}
			$out['properties'] = $props;
		}
		if (isset($schema['items'])) $out['items'] = $this->_translateSchema($schema['items']);

		return $out;
	}

	public function createSession(array $params = array())
	{
		$cfg = array_replace($this->defaults, $params);
		$model = Q::ifset($cfg, 'model', Q_Config::get('AI', 'gemini', 'realTime', 'model', 'gemini-3.1-flash-live-preview'));

		$config = array();

		if (isset($cfg['modalities'])) {
			$modalities = (array)$cfg['modalities'];
			$config['generationConfig'] = array(
				'responseModalities' => array_map('strtoupper', $modalities)
			);
		} else {
			$config['generationConfig'] = array('responseModalities' => array('AUDIO'));
		}

		if (isset($cfg['instructions'])) {
			$config['systemInstruction'] = array(
				'parts' => array(array('text' => $cfg['instructions']))
			);
		}

		$tools = array();
		if (!empty($cfg['webSearch'])) {
			$tools[] = array('googleSearch' => new stdClass());
		}
		if (!empty($cfg['tools'])) {
			$declarations = array();
			foreach ($cfg['tools'] as $tool) {
				$declarations[] = $this->_translateFunctionTool($tool);
			}
			$tools[] = array('functionDeclarations' => $declarations);
		}
		if ($tools) $config['tools'] = $tools;

		// array_key_exists, not isset -- post.php always passes
		// turn_detection explicitly (usually null for manual mode), and
		// isset() would treat that null the same as "not passed at all".
		// Gemini has no "off" value to forward -- ANY value here (including
		// OpenAI's null) means "the client controls turns manually", so it
		// maps to automaticActivityDetection.disabled:true regardless of
		// what the value actually is. Omit turn_detection entirely from
		// $cfg to get Gemini's automatic-VAD default instead.
		if (array_key_exists('turn_detection', $cfg)) {
			$config['realtimeInputConfig'] = array(
				'automaticActivityDetection' => array('disabled' => true)
			);
		}

		if (!empty($cfg['input_audio_transcription'])) {
			$config['inputAudioTranscription'] = new stdClass();
		}

		// BidiGenerateContentSetup shape -- same object both the auth token's
		// constraint and the client's own first WS message use (see the
		// 'session' key returned below), so what we lock server-side and
		// what the client actually opens with can't drift apart.
		$setup = array_merge(array('model' => 'models/' . $model), $config);

		$ttl = (int)Q::ifset($cfg, 'ttl', 60);
		$now = time();
		// No wrapper -- the request body IS the auth_token resource
		// directly (a prior attempt at wrapping this under "authToken" was
		// wrong, per the API's own "Unknown name authToken at 'auth_token'"
		// error; that "CreateAuthTokenRequest wraps AuthToken" claim seems
		// to describe an SDK method's named parameter, not the raw REST
		// body shape). The constraint field is "bidiGenerateContentSetup"
		// (an actual BidiGenerateContentSetup object).
		$body = array(
			'uses'                 => 1,
			'expireTime'           => gmdate('Y-m-d\TH:i:s\Z', $now + max($ttl, 30)),
			'newSessionExpireTime' => gmdate('Y-m-d\TH:i:s\Z', $now + 60),
			'bidiGenerateContentSetup' => $setup
		);

		$response = Q_Utils::post(
			$this->baseUrl . '/v1beta/auth_tokens',
			$body,
			null,
			array(),
			array(
				'Content-Type: application/json',
				'x-goog-api-key: ' . $this->apiKey
			),
			15
		);

		if (!$response) {
			throw new Exception('AI_Voice_Gemini: empty response from auth_tokens endpoint');
		}
		$decoded = is_array($response) ? $response : json_decode($response, true);
		if (!is_array($decoded)) {
			throw new Exception('AI_Voice_Gemini: non-JSON response: '
				. substr((string)$response, 0, 300));
		}
		if (isset($decoded['error'])) {
			$msg = is_array($decoded['error']) && isset($decoded['error']['message'])
				? $decoded['error']['message']
				: json_encode($decoded['error']);
			throw new Exception('AI_Voice_Gemini error: ' . $msg);
		}

		$token = Q::ifset($decoded, 'name', null);
		if (!$token) {
			throw new Exception('AI_Voice_Gemini: response missing "name" (token): '
				. substr((string)$response, 0, 300));
		}

		return array(
			'token'     => $token,
			'wsUrl'     => 'wss://generativelanguage.googleapis.com/ws/'
				. 'google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained',
			'wrtcUrl'   => null, // Gemini Live is WebSocket-only, no WebRTC transport
			'protocol'  => 'gemini-live',
			'model'     => $model,
			'expiresAt' => $now + $ttl,
			'mode'      => 'direct',
			// A JSON STRING, not a nested structure: something in the
			// response pipeline between here and the browser (Q_Response /
			// Q_JSON, or an event handler hooked into it) corrupts nested
			// object trees that contain "properties"/"required" keys --
			// confirmed by comparing a plain json_encode() snapshot taken
			// at this exact point (correct) against the same data placed in
			// a real response slot as a nested object (corrupted: every
			// properties.* value and required[] element replaced with []).
			// A plain string sails through the same pipeline intact, so
			// GeminiLive.js's connect() JSON.parses this back into an
			// object client-side instead of using it as one directly.
			'session'   => array('setupJSON' => json_encode($setup))
		);
	}
}
