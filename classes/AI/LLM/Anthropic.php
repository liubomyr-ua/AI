<?php

/**
 * AI_LLM_Anthropic — direct api.anthropic.com adapter.
 *
 * For deployments where AWS Bedrock isn't available, or where direct
 * Anthropic features (latest models, prompt caching, extended thinking,
 * tool use, vision, full message-shape control) are needed.
 *
 * Implements AI_LLM_AdvancedInterface for prompt-caching via cache_control.
 * Prewarm/list/drop throw NotSupported (Anthropic doesn't expose those).
 *
 * Config:
 *   AI/anthropic/apiKey       — required
 *   AI/anthropic/baseUrl      — defaults to https://api.anthropic.com
 *   AI/anthropic/llm_model_id — defaults to claude-sonnet-4-6
 *   AI/anthropic/version      — anthropic-version header; defaults 2023-06-01
 *   AI/llm/maxTokens          — default max_tokens cap
 *
 * Notes on parity with the AWS/Bedrock adapter:
 *   - Same executeModel signature and option semantics.
 *   - Same callback / batching contract (sync vs async behavior).
 *   - Vision (images) supported via input.images binary array.
 *   - PDF inputs supported via input.pdfs (Claude 3.5 Sonnet+ documents).
 *   - Tool use: pass options.tools and the adapter wires them into the
 *     Anthropic request.
 */
class AI_LLM_Anthropic extends AI_LLM implements AI_LLM_Interface, AI_LLM_AdvancedInterface
{
	protected $apiKey;
	protected $baseUrl;
	protected $defaultModel;
	protected $apiVersion;

	function __construct($options = array())
	{
		// Config-driven, but caller options override.
		$this->apiKey = isset($options['apiKey'])
			? $options['apiKey']
			: Q_Config::expect('AI', 'anthropic', 'apiKey');

		$this->baseUrl = isset($options['baseUrl'])
			? rtrim($options['baseUrl'], '/')
			: rtrim(Q_Config::get(array('AI', 'anthropic', 'baseUrl'), 'https://api.anthropic.com'), '/');

		$this->apiVersion = isset($options['version'])
			? $options['version']
			: Q_Config::get(array('AI', 'anthropic', 'version'), '2023-06-01');

		$defaultModel = isset($options['model'])
			? $options['model']
			: Q_Config::get(array('AI', 'anthropic', 'llm_model_id'), 'claude-sonnet-4-6');

		// Allow override via AI/llm/models/anthropic
		$this->defaultModel = Q_Config::get(
			array('AI', 'llm', 'models', 'anthropic'),
			$defaultModel
		);
	}

	/**
	 * Execute a single direct Anthropic call.
	 * Same contract as AI_LLM_Interface::executeModel.
	 */
	public function executeModel($instructions, array $inputs, array $options = array(), &$raw = null)
	{
		return $this->_execute($instructions, $inputs, $options, $raw, null);
	}

	public function executeWithCachedPrefix($cacheKey, $systemPrefix, array $inputs, array $options = array())
	{
		// Anthropic does prompt caching at the message level via
		// cache_control breakpoints. We mark the system prefix as cacheable
		// and concatenate with normal instructions.
		$options['__cachePrefix']    = $systemPrefix;
		$options['__cachePrefixKey'] = $cacheKey;
		return $this->_execute(
			isset($options['additionalInstructions']) ? $options['additionalInstructions'] : '',
			$inputs,
			$options,
			$raw,
			null
		);
	}

	public function supportsPrefixCache()
	{
		return true;
	}

	public function prewarmPrefix($cacheKey, $systemPrefix, array $options = array())
	{
		throw new AI_LLM_Exception_NotSupported(
			'AI_LLM_Anthropic: prewarmPrefix not supported by Anthropic API. '
			. 'First call with cacheKey establishes the cache; subsequent calls reuse it.'
		);
	}

	public function listCachedPrefixes()
	{
		throw new AI_LLM_Exception_NotSupported(
			'AI_LLM_Anthropic: listCachedPrefixes not supported (Anthropic caches are opaque).'
		);
	}

	public function dropCachedPrefix($cacheKey)
	{
		throw new AI_LLM_Exception_NotSupported(
			'AI_LLM_Anthropic: dropCachedPrefix not supported. '
			. 'Anthropic caches expire automatically (5 minutes for ephemeral).'
		);
	}

	/* ---------- Internal: shared request builder ---------- */

	protected function _execute($instructions, array $inputs, array $options, &$raw, $explicitCachePrefix)
	{
		$model = isset($options['model']) ? $options['model'] : $this->defaultModel;

		$maxTokens   = Q::ifset($options, 'max_tokens',
			Q_Config::get(array('AI', 'llm', 'maxTokens'), 4096));
		$temperature = Q::ifset($options, 'temperature', 0.5);
		$timeout     = Q::ifset($options, 'timeout', 120);

		$responseFormat = Q::ifset($options, 'response_format', null);
		$schema         = Q::ifset($options, 'json_schema', null);

		$userCallback = Q::ifset($options, 'callback', null);

		// Build the system block. Prefer explicit cache prefix when given;
		// otherwise concat instructions and additional content.
		$systemBlocks = array();
		$cachePrefix = isset($options['__cachePrefix']) ? $options['__cachePrefix'] : null;
		$cacheKey    = isset($options['__cachePrefixKey']) ? $options['__cachePrefixKey'] : null;

		if ($cachePrefix !== null) {
			// System prefix marked for caching (Anthropic uses cache_control)
			$block = array(
				'type' => 'text',
				'text' => $cachePrefix
			);
			// Add cache_control breakpoint
			$block['cache_control'] = array('type' => 'ephemeral');
			$systemBlocks[] = $block;

			// Additional non-cached instructions appended.
			if ($instructions !== '' && $instructions !== null) {
				$systemBlocks[] = array('type' => 'text', 'text' => $instructions);
			}
		} elseif ($instructions) {
			$systemBlocks[] = array('type' => 'text', 'text' => $instructions);
		}

		// JSON schema enforcement — we add it to system instructions.
		// Anthropic supports JSON via prompting + the tool_choice trick.
		if ($responseFormat === 'json_schema' && $schema) {
			$systemBlocks[] = array(
				'type' => 'text',
				'text' => "Respond ONLY with valid JSON conforming to this schema:\n"
					. json_encode($schema, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES)
					. "\nNo prose, no markdown fences."
			);
		} elseif ($responseFormat === 'json') {
			$systemBlocks[] = array(
				'type' => 'text',
				'text' => 'Respond ONLY with valid JSON. No prose, no markdown fences.'
			);
		}

		// Build messages from options['messages'] or legacy fields.
		$messages = $this->_buildMessages($options, $inputs);

		// Construct request body.
		$body = array(
			'model'       => $model,
			'max_tokens'  => $maxTokens,
			'temperature' => $temperature,
			'messages'    => $messages
		);
		if (!empty($systemBlocks)) {
			$body['system'] = $systemBlocks;
		}

		// Tool use, if requested.
		if (!empty($options['tools'])) {
			$body['tools'] = $options['tools'];
			if (!empty($options['tool_choice'])) {
				$body['tool_choice'] = $options['tool_choice'];
			}
		}

		$headers = array(
			'Content-Type'      => 'application/json',
			'x-api-key'         => $this->apiKey,
			'anthropic-version' => $this->apiVersion
		);

		// Async (callback) mode
		if ($userCallback && is_callable($userCallback)) {
			$batchHandle = Q::ifset($options, 'batchHandle', null);
			if ($batchHandle) {
				$batchHandle->add(array(
					'method'  => 'POST',
					'url'     => $this->baseUrl . '/v1/messages',
					'headers' => $headers,
					'body'    => $body,
					'timeout' => $timeout,
					'callback' => function ($result, $err) use ($userCallback, &$raw) {
						$text = $this->_extractText($result, $raw);
						call_user_func($userCallback, array('text' => $text, 'err' => $err));
					}
				));
				return $batchHandle->lastRequestIndex();
			}
		}

		// Sync mode
		$response = Q_Utils::post(
			$this->baseUrl . '/v1/messages',
			$body,
			null,
			array(
				'CURLOPT_HTTPHEADER' => $this->_curlHeaders($headers),
				'CURLOPT_TIMEOUT'    => $timeout
			)
		);

		if (!$response) {
			throw new Exception('AI_LLM_Anthropic: empty response');
		}

		$decoded = is_array($response) ? $response : json_decode($response, true);
		if (!is_array($decoded)) {
			throw new Exception('AI_LLM_Anthropic: non-JSON response');
		}
		if (!empty($decoded['error'])) {
			$msg = is_array($decoded['error']) && isset($decoded['error']['message'])
				? $decoded['error']['message']
				: json_encode($decoded['error']);
			throw new Exception('AI_LLM_Anthropic error: ' . $msg);
		}

		$raw = $decoded;
		return $this->_extractText($decoded, $raw);
	}

	protected function _buildMessages(array $options, array $inputs)
	{
		// Prefer options['messages'] (canonical).
		if (!empty($options['messages']) && is_array($options['messages'])) {
			$result = array();
			foreach ($options['messages'] as $m) {
				$role = isset($m['role']) ? $m['role'] : 'user';
				// Anthropic doesn't have a 'system' role inside messages
				// (it's the top-level field). Skip any system messages here.
				if ($role === 'system') continue;

				// Anthropic doesn't have a 'tool' role either; tool_result
				// must be wrapped as a user message with content blocks.
				if ($role === 'tool') {
					$result[] = array(
						'role' => 'user',
						'content' => array(array(
							'type' => 'tool_result',
							'tool_use_id' => isset($m['tool_use_id']) ? $m['tool_use_id'] : '',
							'content' => isset($m['content']) ? $m['content'] : ''
						))
					);
					continue;
				}

				// Convert string content to text block array
				if (isset($m['content']) && is_string($m['content'])) {
					$result[] = array('role' => $role, 'content' => $m['content']);
				} else {
					$result[] = $m;
				}
			}
			if (empty($result)) {
				$result[] = array('role' => 'user', 'content' => '');
			}
			return $result;
		}

		// Legacy fallback: assemble from options['user'] + inputs.
		$userText = Q::ifset($options, 'user', '');
		$content = array();
		if ($userText !== '' && $userText !== null) {
			$content[] = array('type' => 'text', 'text' => (string)$userText);
		}

		// Attach images.
		if (!empty($inputs['images']) && is_array($inputs['images'])) {
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

		// Attach PDFs (Claude 3.5 Sonnet+ supports documents).
		if (!empty($inputs['pdfs']) && is_array($inputs['pdfs'])) {
			foreach ($inputs['pdfs'] as $pdf) {
				$content[] = array(
					'type' => 'document',
					'source' => array(
						'type' => 'base64',
						'media_type' => 'application/pdf',
						'data' => is_string($pdf) ? base64_encode($pdf) : ''
					)
				);
			}
		}

		if (empty($content)) {
			$content = array(array('type' => 'text', 'text' => ''));
		}

		return array(array('role' => 'user', 'content' => $content));
	}

	protected function _extractText($response, &$raw)
	{
		$raw = $response;
		if (!is_array($response)) return '';

		// Anthropic response format: {content: [{type: 'text', text: '...'}, ...]}
		if (!empty($response['content']) && is_array($response['content'])) {
			$out = '';
			foreach ($response['content'] as $block) {
				if (isset($block['type']) && $block['type'] === 'text' && isset($block['text'])) {
					$out .= $block['text'];
				}
			}
			return $out;
		}
		return '';
	}

	protected function _curlHeaders($headers)
	{
		$out = array();
		foreach ($headers as $k => $v) {
			$out[] = $k . ': ' . $v;
		}
		return $out;
	}
}
