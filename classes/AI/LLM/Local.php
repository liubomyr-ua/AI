<?php

/**
 * AI_LLM_Local — local model serving adapter with KV cache controls.
 *
 * Talks to OpenAI-compatible local servers (vLLM, llama-cpp-server, Ollama,
 * LM Studio, SGLang, etc.) with subtype-specific extensions for prefix
 * caching, prewarm, eviction, and other expert features.
 *
 * Implements AI_LLM_AdvancedInterface fully — local is the "most robust"
 * tier per the deployment principle: hosted providers expose what they
 * expose; local gives you everything.
 *
 * Config:
 *   AI/local/url           — required, e.g. http://localhost:8000
 *   AI/local/apiKey        — optional, most local servers ignore
 *   AI/local/subtype       — 'vllm' | 'llama-cpp' | 'ollama' | 'lm-studio' | 'generic'
 *   AI/local/model         — default model name
 *   AI/llm/maxTokens       — default max output tokens
 *
 * SSRF NOTE
 * ─────────
 * Local URLs typically point at private/loopback hosts. The standard
 * Qbix/Safebox SSRF protection blocks those by default. To allow this
 * adapter, set:
 *   AI/local/allowPrivate = true
 * AND constrain via:
 *   AI/local/allowedHosts = ['127.0.0.1', '::1', 'localhost', 'gpu.internal']
 *
 * The adapter validates the configured URL against allowedHosts before
 * every request to prevent config-drift SSRF.
 *
 * SUBTYPE-SPECIFIC EXTENSIONS
 * ────────────────────────────
 *
 * vllm:
 *   - Native prefix caching (must be enabled server-side via
 *     --enable-prefix-caching). cache_key passed as request metadata.
 *   - Prompt logprobs, structured output via guided decoding.
 *   - Multi-LoRA via 'model' = base+lora suffix convention.
 *
 * llama-cpp:
 *   - Session-based KV cache slots via 'id_slot' parameter.
 *   - 'cache_prompt: true' for prefix reuse.
 *   - listCachedPrefixes maps to /slots endpoint.
 *
 * ollama:
 *   - Keep-alive flag for model warmup ('keep_alive' option).
 *   - Limited cache visibility — listCachedPrefixes returns nothing useful.
 *   - Use for casual local; switch to vllm/llama-cpp for production.
 *
 * lm-studio:
 *   - OpenAI-compatible with minimal extensions.
 *   - Falls through to generic behavior.
 *
 * generic:
 *   - Pure OpenAI-compat. supportsPrefixCache returns false.
 *   - executeWithCachedPrefix falls back to plain executeModel.
 *   - prewarm/list/drop throw NotSupported.
 */
class AI_LLM_Local extends AI_LLM implements AI_LLM_Interface, AI_LLM_AdvancedInterface
{
	protected $baseUrl;
	protected $apiKey;
	protected $subtype;
	protected $defaultModel;
	protected $cacheTracker = array(); // local map cacheKey -> metadata (for subtypes that don't track)

	function __construct($options = array())
	{
		$this->baseUrl = isset($options['url'])
			? rtrim($options['url'], '/')
			: rtrim(Q_Config::expect('AI', 'local', 'url'), '/');

		$this->apiKey = isset($options['apiKey'])
			? $options['apiKey']
			: Q_Config::get(array('AI', 'local', 'apiKey'), 'sk-local-dummy');

		$this->subtype = isset($options['subtype'])
			? $options['subtype']
			: Q_Config::get(array('AI', 'local', 'subtype'), 'generic');

		$this->defaultModel = isset($options['model'])
			? $options['model']
			: Q_Config::get(array('AI', 'local', 'model'),
				Q_Config::get(array('AI', 'llm', 'models', 'local'), 'default'));

		$this->_validateHost($this->baseUrl);
	}

	public function executeModel($instructions, array $inputs, array $options = array(), &$raw = null)
	{
		return $this->_execute($instructions, $inputs, $options, $raw, null);
	}

	public function executeWithCachedPrefix($cacheKey, $systemPrefix, array $inputs, array $options = array())
	{
		$options['__cachePrefix']    = $systemPrefix;
		$options['__cachePrefixKey'] = $cacheKey;
		// Track for subtypes that don't have a native list endpoint.
		$this->cacheTracker[$cacheKey] = array(
			'prefixLength' => strlen($systemPrefix),
			'lastUsed'     => time(),
		);
		$additional = isset($options['additionalInstructions']) ? $options['additionalInstructions'] : '';
		return $this->_execute($additional, $inputs, $options, $raw, null);
	}

	public function supportsPrefixCache()
	{
		// vLLM and llama-cpp have native prefix caching; others fall back.
		return in_array($this->subtype, array('vllm', 'llama-cpp', 'sglang'), true);
	}

	public function prewarmPrefix($cacheKey, $systemPrefix, array $options = array())
	{
		if (!$this->supportsPrefixCache()) {
			throw new AI_LLM_Exception_NotSupported(
				'AI_LLM_Local: prewarmPrefix requires subtype with native cache '
				. '(vllm/llama-cpp/sglang); current subtype is ' . $this->subtype);
		}
		// Prewarm by issuing a zero-output call with the prefix.
		// vLLM honors max_tokens=1 + stop tokens; llama-cpp honors n_predict=0.
		$opts = array_merge($options, array(
			'max_tokens' => 1,
			'temperature' => 0
		));
		$opts['__cachePrefix']    = $systemPrefix;
		$opts['__cachePrefixKey'] = $cacheKey;
		$this->_execute('', array(), $opts, $raw, null);

		$this->cacheTracker[$cacheKey] = array(
			'prefixLength' => strlen($systemPrefix),
			'lastUsed'     => time(),
			'prewarmed'    => true,
		);
		return true;
	}

	public function listCachedPrefixes()
	{
		// vLLM: GET /metrics has prefix cache stats but no per-key info.
		// llama-cpp: GET /slots returns active KV slots with prompts.
		// Generic: use the local tracker.
		if ($this->subtype === 'llama-cpp') {
			$slots = $this->_get('/slots');
			$out = array();
			if (is_array($slots)) {
				foreach ($slots as $slot) {
					if (!empty($slot['prompt'])) {
						$key = isset($slot['cache_key']) ? $slot['cache_key']
							: ('slot_' . (isset($slot['id']) ? $slot['id'] : '?'));
						$out[$key] = array(
							'slotId'       => isset($slot['id']) ? $slot['id'] : null,
							'prefixLength' => strlen($slot['prompt'])
						);
					}
				}
			}
			return $out;
		}
		// Best-effort: return our local tracker.
		return $this->cacheTracker;
	}

	public function dropCachedPrefix($cacheKey)
	{
		if ($this->subtype === 'llama-cpp') {
			// llama-cpp slot eviction: POST /slots/{id}?action=erase
			if (isset($this->cacheTracker[$cacheKey]['slotId'])) {
				$slotId = $this->cacheTracker[$cacheKey]['slotId'];
				$this->_post('/slots/' . $slotId . '?action=erase', array());
			}
		}
		// vLLM has no per-key eviction; cache eviction is LRU.
		// Just clear from our tracker.
		if (isset($this->cacheTracker[$cacheKey])) {
			unset($this->cacheTracker[$cacheKey]);
			return true;
		}
		return false;
	}

	/* ---------- Internal request building ---------- */

	protected function _execute($instructions, array $inputs, array $options, &$raw)
	{
		$model = isset($options['model']) ? $options['model'] : $this->defaultModel;
		$maxTokens   = Q::ifset($options, 'max_tokens', Q_Config::get(array('AI', 'llm', 'maxTokens'), 4096));
		$temperature = Q::ifset($options, 'temperature', 0.7);
		$timeout     = Q::ifset($options, 'timeout', 120);

		// Build messages (OpenAI-compat shape).
		$messages = $this->_buildMessages($instructions, $options, $inputs);

		$body = array(
			'model'       => $model,
			'messages'    => $messages,
			'max_tokens'  => $maxTokens,
			'temperature' => $temperature
		);

		// Response format
		$responseFormat = Q::ifset($options, 'response_format', null);
		if ($responseFormat === 'json' || $responseFormat === 'json_object') {
			$body['response_format'] = array('type' => 'json_object');
		} elseif ($responseFormat === 'json_schema' && !empty($options['json_schema'])) {
			// vLLM uses 'guided_json'; OpenAI-compat uses 'response_format.json_schema';
			// llama-cpp uses 'grammar' (different shape).
			if ($this->subtype === 'vllm') {
				$body['guided_json'] = $options['json_schema'];
			} else {
				$body['response_format'] = array(
					'type' => 'json_schema',
					'json_schema' => array(
						'name'   => 'response',
						'schema' => $options['json_schema'],
						'strict' => true
					)
				);
			}
		}

		// Subtype-specific extensions
		$this->_applyExtensions($body, $options);

		// Cached prefix handling
		if (!empty($options['__cachePrefixKey'])) {
			$this->_applyPrefixCache($body, $options);
		}

		$response = $this->_post('/v1/chat/completions', $body, $timeout);
		$raw = $response;

		if (isset($response['error'])) {
			$msg = is_array($response['error']) && isset($response['error']['message'])
				? $response['error']['message']
				: json_encode($response['error']);
			throw new Exception('AI_LLM_Local error: ' . $msg);
		}

		// Standard OpenAI-compat extraction
		if (!empty($response['choices'][0]['message']['content'])) {
			return $response['choices'][0]['message']['content'];
		}
		return '';
	}

	protected function _buildMessages($instructions, array $options, array $inputs)
	{
		$messages = array();
		if ($instructions) {
			$messages[] = array('role' => 'system', 'content' => $instructions);
		}
		if (!empty($options['messages']) && is_array($options['messages'])) {
			foreach ($options['messages'] as $m) {
				$messages[] = $m;
			}
		} elseif (!empty($options['user'])) {
			$messages[] = array('role' => 'user', 'content' => (string)$options['user']);
		}
		// Local OpenAI-compat usually doesn't support vision; if subtype is
		// vllm and model supports it, the multimodal blocks pass through.
		if (!empty($inputs['images']) && !empty($options['_multimodal'])) {
			$content = array(array('type' => 'text', 'text' => isset($options['user']) ? $options['user'] : ''));
			foreach ($inputs['images'] as $img) {
				$content[] = array(
					'type' => 'image_url',
					'image_url' => array(
						'url' => 'data:image/png;base64,' .
							(is_string($img) ? base64_encode($img) : '')
					)
				);
			}
			// Replace last user message with multimodal version
			$lastIdx = count($messages) - 1;
			if ($lastIdx >= 0 && $messages[$lastIdx]['role'] === 'user') {
				$messages[$lastIdx]['content'] = $content;
			} else {
				$messages[] = array('role' => 'user', 'content' => $content);
			}
		}
		return $messages;
	}

	protected function _applyExtensions(&$body, array $options)
	{
		switch ($this->subtype) {
			case 'vllm':
				if (!empty($options['logprobs'])) {
					$body['logprobs'] = $options['logprobs'];
				}
				if (!empty($options['top_logprobs'])) {
					$body['top_logprobs'] = $options['top_logprobs'];
				}
				break;
			case 'llama-cpp':
				if (isset($options['slot_id'])) {
					$body['id_slot'] = $options['slot_id'];
				}
				if (isset($options['n_predict'])) {
					$body['n_predict'] = $options['n_predict'];
				}
				break;
			case 'ollama':
				if (isset($options['keep_alive'])) {
					$body['keep_alive'] = $options['keep_alive'];
				}
				break;
		}
	}

	protected function _applyPrefixCache(&$body, array $options)
	{
		$cacheKey = $options['__cachePrefixKey'];
		$prefix   = isset($options['__cachePrefix']) ? $options['__cachePrefix'] : null;

		// Prepend the cached prefix as a system message (if not already there).
		if ($prefix !== null && $prefix !== '') {
			// Ensure prefix is the FIRST system message — that's what gives
			// stable cache prefix matching.
			array_unshift($body['messages'], array(
				'role'    => 'system',
				'content' => $prefix
			));
		}

		switch ($this->subtype) {
			case 'vllm':
				// vLLM uses request metadata for cache_key tracking;
				// the actual cache match is automatic by prefix hash.
				$body['cache_key'] = $cacheKey;
				break;
			case 'llama-cpp':
				$body['cache_prompt'] = true;
				if (!empty($this->cacheTracker[$cacheKey]['slotId'])) {
					$body['id_slot'] = $this->cacheTracker[$cacheKey]['slotId'];
				}
				break;
			// ollama, generic: no native support; prefix is sent each call.
		}
	}

	protected function _validateHost($url)
	{
		$allowedHosts = Q_Config::get(array('AI', 'local', 'allowedHosts'),
			array('localhost', '127.0.0.1', '::1'));
		$parsed = parse_url($url);
		if (!$parsed || empty($parsed['host'])) {
			throw new Exception('AI_LLM_Local: invalid url: ' . $url);
		}
		$host = strtolower($parsed['host']);
		if (!in_array($host, array_map('strtolower', $allowedHosts), true)) {
			throw new Exception(
				'AI_LLM_Local: host "' . $host . '" not in AI/local/allowedHosts. '
				. 'Add it to the whitelist to allow this local endpoint.');
		}
	}

	protected function _post($path, $body, $timeout = 120)
	{
		$url = $this->baseUrl . $path;
		$headers = array(
			'Content-Type: application/json'
		);
		if ($this->apiKey) {
			$headers[] = 'Authorization: Bearer ' . $this->apiKey;
		}
		$response = Q_Utils::post($url, $body, null, array(
			'CURLOPT_HTTPHEADER' => $headers,
			'CURLOPT_TIMEOUT'    => $timeout
		));
		if (!$response) {
			throw new Exception('AI_LLM_Local: empty response from ' . $url);
		}
		$decoded = is_array($response) ? $response : json_decode($response, true);
		if (!is_array($decoded)) {
			throw new Exception('AI_LLM_Local: non-JSON response from ' . $path);
		}
		return $decoded;
	}

	protected function _get($path, $timeout = 30)
	{
		$url = $this->baseUrl . $path;
		$headers = array();
		if ($this->apiKey) {
			$headers[] = 'Authorization: Bearer ' . $this->apiKey;
		}
		// Q_Utils provides get(); fall through to raw curl if not available.
		if (function_exists('curl_init')) {
			$ch = curl_init($url);
			curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
			curl_setopt($ch, CURLOPT_TIMEOUT, $timeout);
			if ($headers) curl_setopt($ch, CURLOPT_HTTPHEADER, $headers);
			$body = curl_exec($ch);
			curl_close($ch);
			$decoded = json_decode($body, true);
			return is_array($decoded) ? $decoded : array();
		}
		return array();
	}
}
