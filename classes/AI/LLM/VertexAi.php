<?php

/**
 * AI_LLM_VertexAi — Google Cloud Vertex AI adapter.
 *
 * Vertex is Google's enterprise model platform. Different from AI Studio
 * (the AI_LLM_Google class): Vertex uses OAuth2 with a service account,
 * region-scoped endpoints, and hosts multiple providers — Gemini, Anthropic
 * Claude, Llama, Mistral, and others — through one API surface.
 *
 * Model name conventions on Vertex:
 *   - Gemini:    "publishers/google/models/gemini-2.5-pro"
 *   - Anthropic: "publishers/anthropic/models/claude-sonnet-4-5"
 *   - Meta:      "publishers/meta/models/llama-3.3-70b-instruct"
 *
 * The adapter auto-detects the provider from the publisher segment and
 * dispatches to the appropriate request shape:
 *   - publishers/google/...    → Vertex Gemini API shape (generateContent)
 *   - publishers/anthropic/... → Anthropic-on-Vertex shape (rawPredict with messages)
 *   - publishers/meta/...      → Vertex Llama shape (chat completions)
 *
 * Config:
 *   AI/vertex/projectId        — required
 *   AI/vertex/location         — required (e.g. 'us-central1')
 *   AI/vertex/credentialsPath  — path to service account JSON key
 *     OR
 *   AI/vertex/accessToken      — pre-acquired OAuth2 token (override)
 *   AI/vertex/model            — default model (publisher path)
 *
 * For deployments using Workload Identity (GKE / Cloud Run), set
 * AI/vertex/credentialsPath empty and rely on the metadata-server-fetched
 * token. (Auth helper is invoked lazily; if Workload Identity isn't
 * present, an explicit credentials path or accessToken is required.)
 */
class AI_LLM_VertexAi extends AI_LLM implements AI_LLM_Interface, AI_LLM_AdvancedInterface
{
	protected $projectId;
	protected $location;
	protected $credentialsPath;
	protected $accessToken;
	protected $defaultModel;
	protected $tokenExpiry = 0;

	function __construct($options = array())
	{
		$this->projectId = isset($options['projectId'])
			? $options['projectId']
			: Q_Config::expect('AI', 'vertex', 'projectId');
		$this->location = isset($options['location'])
			? $options['location']
			: Q_Config::get(array('AI', 'vertex', 'location'), 'us-central1');
		$this->credentialsPath = isset($options['credentialsPath'])
			? $options['credentialsPath']
			: Q_Config::get(array('AI', 'vertex', 'credentialsPath'), null);
		if (!empty($options['accessToken'])) {
			$this->accessToken = $options['accessToken'];
			$this->tokenExpiry = time() + 3600;
		}
		$this->defaultModel = isset($options['model'])
			? $options['model']
			: Q_Config::get(array('AI', 'llm', 'models', 'vertex'),
				'publishers/google/models/gemini-2.5-flash');
	}

	public function executeModel($instructions, array $inputs, array $options = array(), &$raw = null)
	{
		$model = isset($options['model']) ? $options['model'] : $this->defaultModel;
		$publisher = $this->_detectPublisher($model);

		switch ($publisher) {
			case 'anthropic':
				return $this->_executeAnthropic($model, $instructions, $inputs, $options, $raw);
			case 'meta':
			case 'mistralai':
				return $this->_executeOpenAICompat($model, $instructions, $inputs, $options, $raw);
			case 'google':
			default:
				return $this->_executeGemini($model, $instructions, $inputs, $options, $raw);
		}
	}

	public function executeWithCachedPrefix($cacheKey, $systemPrefix, array $inputs, array $options = array())
	{
		$model = isset($options['model']) ? $options['model'] : $this->defaultModel;
		$publisher = $this->_detectPublisher($model);

		if ($publisher === 'anthropic') {
			// Anthropic-on-Vertex supports cache_control like direct Anthropic.
			$options['__cachePrefix']    = $systemPrefix;
			$options['__cachePrefixKey'] = $cacheKey;
			$additional = isset($options['additionalInstructions']) ? $options['additionalInstructions'] : '';
			return $this->_executeAnthropic($model, $additional, $inputs, $options, $raw);
		}
		if ($publisher === 'google') {
			// Vertex Gemini supports context caching via a different mechanism
			// (cachedContents resource). For now, fall back to non-cached
			// execution — the caller can implement explicit context caching
			// via a separate code path if needed.
			$prefixed = ($systemPrefix ? $systemPrefix . "\n\n" : '')
				. (isset($options['additionalInstructions']) ? $options['additionalInstructions'] : '');
			return $this->_executeGemini($model, $prefixed, $inputs, $options, $raw);
		}
		// Open-weight models on Vertex don't have prefix caching at the API level.
		$prefixed = ($systemPrefix ? $systemPrefix . "\n\n" : '')
			. (isset($options['additionalInstructions']) ? $options['additionalInstructions'] : '');
		return $this->_executeOpenAICompat($model, $prefixed, $inputs, $options, $raw);
	}

	public function supportsPrefixCache()
	{
		// Conservatively true (depends on model), since Anthropic-on-Vertex does.
		return true;
	}

	public function prewarmPrefix($cacheKey, $systemPrefix, array $options = array())
	{
		throw new AI_LLM_Exception_NotSupported(
			'AI_LLM_VertexAi: prewarmPrefix not directly supported via OpenAI-compat call. '
			. 'For Gemini, use Vertex cachedContents API directly; for Anthropic-on-Vertex, '
			. 'cache is established on first executeWithCachedPrefix call.');
	}

	public function listCachedPrefixes()
	{
		throw new AI_LLM_Exception_NotSupported(
			'AI_LLM_VertexAi: listCachedPrefixes not supported (Vertex caches are managed server-side).');
	}

	public function dropCachedPrefix($cacheKey)
	{
		throw new AI_LLM_Exception_NotSupported(
			'AI_LLM_VertexAi: dropCachedPrefix not supported via this adapter.');
	}

	/* ---------- Provider dispatch ---------- */

	protected function _detectPublisher($model)
	{
		if (strpos($model, 'publishers/anthropic/') !== false) return 'anthropic';
		if (strpos($model, 'publishers/meta/')      !== false) return 'meta';
		if (strpos($model, 'publishers/mistralai/') !== false) return 'mistralai';
		if (strpos($model, 'publishers/google/')    !== false) return 'google';
		// Bare model name — default to google.
		return 'google';
	}

	protected function _executeGemini($model, $instructions, array $inputs, array $options, &$raw)
	{
		$endpoint = 'https://' . $this->location . '-aiplatform.googleapis.com/v1/projects/'
			. $this->projectId . '/locations/' . $this->location . '/' . $model
			. ':generateContent';

		$contents = $this->_buildGeminiContents($options, $inputs);
		$body = array(
			'contents' => $contents,
			'generationConfig' => array(
				'temperature' => Q::ifset($options, 'temperature', 0.5),
				'maxOutputTokens' => Q::ifset($options, 'max_tokens',
					Q_Config::get(array('AI', 'llm', 'maxTokens'), 4096))
			)
		);
		if ($instructions) {
			$body['systemInstruction'] = array(
				'parts' => array(array('text' => $instructions))
			);
		}
		if (!empty($options['json_schema'])) {
			$body['generationConfig']['responseMimeType'] = 'application/json';
			$body['generationConfig']['responseSchema'] = $options['json_schema'];
		}

		$response = $this->_authedPost($endpoint, $body, Q::ifset($options, 'timeout', 120));
		$raw = $response;
		if (isset($response['error'])) {
			throw new Exception('AI_LLM_VertexAi (Gemini) error: '
				. (is_array($response['error']) ? json_encode($response['error']) : $response['error']));
		}
		$text = '';
		if (!empty($response['candidates'][0]['content']['parts'])) {
			foreach ($response['candidates'][0]['content']['parts'] as $part) {
				if (isset($part['text'])) $text .= $part['text'];
			}
		}
		return $text;
	}

	protected function _executeAnthropic($model, $instructions, array $inputs, array $options, &$raw)
	{
		// Anthropic-on-Vertex uses rawPredict with messages-style body.
		// Endpoint: /v1/projects/{p}/locations/{l}/publishers/anthropic/models/{m}:rawPredict
		$endpoint = 'https://' . $this->location . '-aiplatform.googleapis.com/v1/projects/'
			. $this->projectId . '/locations/' . $this->location . '/' . $model
			. ':rawPredict';

		$systemBlocks = array();
		if (isset($options['__cachePrefix']) && $options['__cachePrefix'] !== null) {
			$systemBlocks[] = array(
				'type' => 'text',
				'text' => $options['__cachePrefix'],
				'cache_control' => array('type' => 'ephemeral')
			);
			if ($instructions) {
				$systemBlocks[] = array('type' => 'text', 'text' => $instructions);
			}
		} elseif ($instructions) {
			$systemBlocks[] = array('type' => 'text', 'text' => $instructions);
		}

		$messages = $this->_buildAnthropicMessages($options, $inputs);

		$body = array(
			'anthropic_version' => 'vertex-2023-10-16',
			'max_tokens' => Q::ifset($options, 'max_tokens', Q_Config::get(array('AI', 'llm', 'maxTokens'), 4096)),
			'temperature' => Q::ifset($options, 'temperature', 0.5),
			'messages' => $messages
		);
		if ($systemBlocks) $body['system'] = $systemBlocks;

		$response = $this->_authedPost($endpoint, $body, Q::ifset($options, 'timeout', 120));
		$raw = $response;
		if (isset($response['error'])) {
			throw new Exception('AI_LLM_VertexAi (Anthropic) error: '
				. (is_array($response['error']) ? json_encode($response['error']) : $response['error']));
		}
		$text = '';
		if (!empty($response['content']) && is_array($response['content'])) {
			foreach ($response['content'] as $block) {
				if (isset($block['type']) && $block['type'] === 'text' && isset($block['text'])) {
					$text .= $block['text'];
				}
			}
		}
		return $text;
	}

	protected function _executeOpenAICompat($model, $instructions, array $inputs, array $options, &$raw)
	{
		// Vertex hosts Llama, Mistral, etc. through OpenAI-compatible endpoints.
		// Endpoint: /v1/projects/{p}/locations/{l}/endpoints/openapi/chat/completions
		$endpoint = 'https://' . $this->location . '-aiplatform.googleapis.com/v1/projects/'
			. $this->projectId . '/locations/' . $this->location
			. '/endpoints/openapi/chat/completions';

		$messages = array();
		if ($instructions) {
			$messages[] = array('role' => 'system', 'content' => $instructions);
		}
		if (!empty($options['messages']) && is_array($options['messages'])) {
			foreach ($options['messages'] as $m) $messages[] = $m;
		} elseif (!empty($options['user'])) {
			$messages[] = array('role' => 'user', 'content' => (string)$options['user']);
		}

		$body = array(
			'model'       => $model,
			'messages'    => $messages,
			'max_tokens'  => Q::ifset($options, 'max_tokens', Q_Config::get(array('AI', 'llm', 'maxTokens'), 4096)),
			'temperature' => Q::ifset($options, 'temperature', 0.5)
		);

		$response = $this->_authedPost($endpoint, $body, Q::ifset($options, 'timeout', 120));
		$raw = $response;
		if (isset($response['error'])) {
			throw new Exception('AI_LLM_VertexAi (OpenAI-compat) error: '
				. (is_array($response['error']) ? json_encode($response['error']) : $response['error']));
		}
		return isset($response['choices'][0]['message']['content'])
			? $response['choices'][0]['message']['content']
			: '';
	}

	/* ---------- Helpers ---------- */

	protected function _buildGeminiContents(array $options, array $inputs)
	{
		$contents = array();
		if (!empty($options['messages']) && is_array($options['messages'])) {
			foreach ($options['messages'] as $m) {
				if ($m['role'] === 'system') continue;
				$role = ($m['role'] === 'assistant') ? 'model' : 'user';
				$parts = array();
				if (is_string($m['content'])) {
					$parts[] = array('text' => $m['content']);
				} elseif (is_array($m['content'])) {
					foreach ($m['content'] as $c) {
						if (isset($c['type']) && $c['type'] === 'text') {
							$parts[] = array('text' => $c['text']);
						}
					}
				}
				if ($parts) $contents[] = array('role' => $role, 'parts' => $parts);
			}
			if (!$contents) $contents[] = array('role' => 'user', 'parts' => array(array('text' => '')));
		} else {
			$parts = array();
			if (!empty($options['user'])) {
				$parts[] = array('text' => (string)$options['user']);
			}
			if (!empty($inputs['images'])) {
				foreach ($inputs['images'] as $img) {
					$parts[] = array(
						'inline_data' => array(
							'mime_type' => 'image/png',
							'data'      => is_string($img) ? base64_encode($img) : ''
						)
					);
				}
			}
			if (!$parts) $parts[] = array('text' => '');
			$contents[] = array('role' => 'user', 'parts' => $parts);
		}
		return $contents;
	}

	protected function _buildAnthropicMessages(array $options, array $inputs)
	{
		if (!empty($options['messages']) && is_array($options['messages'])) {
			$out = array();
			foreach ($options['messages'] as $m) {
				if (isset($m['role']) && $m['role'] === 'system') continue;
				$out[] = $m;
			}
			if (!$out) $out[] = array('role' => 'user', 'content' => '');
			return $out;
		}
		$content = array();
		if (!empty($options['user'])) {
			$content[] = array('type' => 'text', 'text' => (string)$options['user']);
		}
		if (!empty($inputs['images'])) {
			foreach ($inputs['images'] as $img) {
				$content[] = array(
					'type' => 'image',
					'source' => array(
						'type' => 'base64',
						'media_type' => 'image/png',
						'data' => is_string($img) ? base64_encode($img) : ''
					)
				);
			}
		}
		if (!$content) $content = array(array('type' => 'text', 'text' => ''));
		return array(array('role' => 'user', 'content' => $content));
	}

	protected function _authedPost($url, $body, $timeout)
	{
		$token = $this->_getAccessToken();
		$response = Q_Utils::post($url, $body, null, array(
			'CURLOPT_HTTPHEADER' => array(
				'Content-Type: application/json',
				'Authorization: Bearer ' . $token
			),
			'CURLOPT_TIMEOUT' => $timeout
		));
		if (!$response) {
			throw new Exception('AI_LLM_VertexAi: empty response from ' . $url);
		}
		$decoded = is_array($response) ? $response : json_decode($response, true);
		if (!is_array($decoded)) {
			throw new Exception('AI_LLM_VertexAi: non-JSON response: ' . substr((string)$response, 0, 500));
		}
		return $decoded;
	}

	protected function _getAccessToken()
	{
		if ($this->accessToken && $this->tokenExpiry > time() + 60) {
			return $this->accessToken;
		}
		if (!$this->credentialsPath) {
			throw new Exception('AI_LLM_VertexAi: credentialsPath required (or pass accessToken). '
				. 'For Workload Identity, set credentialsPath="metadata".');
		}
		if ($this->credentialsPath === 'metadata') {
			// GCP metadata server — Workload Identity path
			$mdUrl = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
			$ch = curl_init($mdUrl);
			curl_setopt($ch, CURLOPT_HTTPHEADER, array('Metadata-Flavor: Google'));
			curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
			curl_setopt($ch, CURLOPT_TIMEOUT, 5);
			$resp = curl_exec($ch);
			curl_close($ch);
			$parsed = json_decode($resp, true);
			if (!is_array($parsed) || empty($parsed['access_token'])) {
				throw new Exception('AI_LLM_VertexAi: failed to acquire token from metadata server');
			}
			$this->accessToken = $parsed['access_token'];
			$this->tokenExpiry = time() + ($parsed['expires_in'] ?? 3600);
			return $this->accessToken;
		}
		// Service account JSON key path — sign JWT and exchange for token.
		$creds = json_decode(@file_get_contents($this->credentialsPath), true);
		if (!is_array($creds) || empty($creds['private_key'])) {
			throw new Exception('AI_LLM_VertexAi: invalid credentials file at ' . $this->credentialsPath);
		}
		$now = time();
		$header  = base64_encode(json_encode(array('alg' => 'RS256', 'typ' => 'JWT')));
		$payload = base64_encode(json_encode(array(
			'iss'   => $creds['client_email'],
			'scope' => 'https://www.googleapis.com/auth/cloud-platform',
			'aud'   => 'https://oauth2.googleapis.com/token',
			'exp'   => $now + 3600,
			'iat'   => $now
		)));
		$sigInput = $header . '.' . $payload;
		openssl_sign($sigInput, $signature, $creds['private_key'], 'sha256WithRSAEncryption');
		$jwt = $sigInput . '.' . base64_encode($signature);

		$tokenResp = Q_Utils::post('https://oauth2.googleapis.com/token', array(
			'grant_type' => 'urn:ietf:params:oauth:grant-type:jwt-bearer',
			'assertion'  => $jwt
		));
		$tokenParsed = is_array($tokenResp) ? $tokenResp : json_decode($tokenResp, true);
		if (!is_array($tokenParsed) || empty($tokenParsed['access_token'])) {
			throw new Exception('AI_LLM_VertexAi: failed to exchange JWT for access token: '
				. substr((string)$tokenResp, 0, 300));
		}
		$this->accessToken = $tokenParsed['access_token'];
		$this->tokenExpiry = $now + ($tokenParsed['expires_in'] ?? 3600);
		return $this->accessToken;
	}
}
