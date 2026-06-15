<?php

class AI_LLM_Google extends AI_LLM implements AI_LLM_Interface
{
	protected $apiKey;
	protected $model;

	function __construct()
	{
		$this->apiKey = Q_Config::expect('AI', 'google', 'api_key');

		$defaultGoogleModel = Q_Config::get(
			'AI',
			'google',
			'llm_model',
			'models/gemini-1.5-flash'
		);

		$this->model = Q_Config::get(
			'AI',
			'llm',
			'models',
			'google',
			$defaultGoogleModel
		);
	}

	/**
	 * Execute a single Gemini model invocation.
	 *
	 * Supports sync + batch (callback) modes.
	 *
	 * Structured outputs: when response_format === 'json_schema' and a schema
	 * is supplied, the adapter sets generationConfig.responseMimeType +
	 * responseSchema (Gemini's native constrained decoding) in addition to the
	 * in-prompt schema. The schema is run through AI_LLM::geminiSchema() to
	 * strip JSON-Schema keywords (additionalProperties) that Gemini's
	 * OpenAPI-subset responseSchema doesn't accept. Toggle the native path with
	 * AI/google/structuredOutputs (default true).
	 */
	public function executeModel($instructions, array $inputs, array $options = array(), &$raw = null)
	{
		$responseFormat = Q::ifset($options, 'response_format', null);
		$schema         = Q::ifset($options, 'json_schema', null);
		$temperature    = Q::ifset($options, 'temperature', 0.5);
		$maxTokens      = Q::ifset($options, 'max_tokens', 3000);

		$userCallback = Q::ifset($options, 'callback', null);

		$model = Q::ifset($options, 'model', $this->model);

		$endpoint =
			'https://generativelanguage.googleapis.com/v1beta/' .
			$model .
			':generateContent?key=' . urlencode($this->apiKey);

		/* ---------- System / schema enforcement (prompt-level) ---------- */

		$system = '';

		if ($responseFormat === 'json_schema' && is_array($schema)) {
			$system .=
				"You are a strict JSON generator.\n" .
				"Output MUST conform exactly to this JSON Schema:\n\n" .
				json_encode($schema, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) .
				"\n\nRules:\n" .
				"- Output JSON only\n" .
				"- Do not include prose, comments, or markdown\n" .
				"- Do not omit required fields\n" .
				"- Use null when uncertain\n\n";
		} elseif ($responseFormat === 'json') {
			$system .=
				"You are a strict JSON generator.\n" .
				"Output MUST be valid JSON.\n" .
				"Do not include prose, comments, or markdown\n\n";
		}

		/* ---------- Build Gemini contents ---------- */

		$parts = array();

		if (!empty($instructions)) {
			$parts[] = array('text' => $system . $instructions);
		} else {
			$parts[] = array('text' => $system);
		}

		if (!empty($inputs['text'])) {
			$parts[] = array('text' => $inputs['text']);
		}

		/**
		 * Multimodal images:
		 * - JPEG preferred
		 * - PNG only if alpha
		 * - Never send WebP
		 * - Correct mime_type always
		 */
		if (!empty($inputs['images']) && is_array($inputs['images'])) {
			foreach ($inputs['images'] as $binary) {

				$rawImg = Q_Utils::toRawBinary($binary);
				if ($rawImg === false) {
					continue;
				}

				$img = @imagecreatefromstring($rawImg);
				if (!$img) {
					continue;
				}

				$hasAlpha = $this->imageHasAlpha($img);

				if ($hasAlpha) {
					ob_start();
					imagepng($img);
					$data = ob_get_clean();
					$mime = 'image/png';
				} else {
					ob_start();
					imagejpeg($img, null, 85);
					$data = ob_get_clean();
					$mime = 'image/jpeg';
				}

				imagedestroy($img);

				$parts[] = array(
					'inline_data' => array(
						'mime_type' => $mime,
						'data'      => base64_encode($data)
					)
				);
			}
		}

		$payload = array(
			'contents' => array(
				array(
					'role'  => 'user',
					'parts' => $parts
				)
			),
			'generationConfig' => array(
				'temperature'     => $temperature,
				'maxOutputTokens' => $maxTokens
			)
		);

		/* ---------- Native structured outputs ---------- */

		$useNative = isset($options['nativeStructured'])
			? $options['nativeStructured']
			: Q_Config::get(array('AI', 'google', 'structuredOutputs'), true);

		if ($responseFormat === 'json_schema' && is_array($schema)) {
			$payload['generationConfig']['responseMimeType'] = 'application/json';
			if ($useNative) {
				$payload['generationConfig']['responseSchema'] = AI_LLM::geminiSchema($schema);
			}
		} elseif ($responseFormat === 'json') {
			$payload['generationConfig']['responseMimeType'] = 'application/json';
		}

		$result = array(
			'text'  => '',
			'raw'   => null,
			'error' => null
		);

		$callback = function ($info, $response) use (&$result, &$raw, $userCallback) {

			$httpCode = Q::ifset($info, 'http_code', 0);

			if ($httpCode >= 200 && $httpCode < 300 && is_string($response)) {

				$decoded = json_decode($response, true);
				if (!is_array($decoded)) {
					$result['error'] = 'Invalid JSON returned by Gemini';
				} else {
					$result['raw']  = $decoded;
					$raw            = $decoded;
					$result['text'] = $this->normalizeGeminiOutput($decoded);
				}

			} else {
				$result['error'] = is_string($response)
					? $response
					: 'Gemini request failed';
			}

			if ($userCallback && is_callable($userCallback)) {
				try {
					call_user_func($userCallback, $result);
				} catch (Exception $e) {
					error_log($e);
				}
			}
		};

		$response = Q_Utils::post(
			$endpoint,
			$payload,
			null,
			null,
			array('Content-Type: application/json'),
			Q::ifset($options, 'timeout', 300),
			$callback
		);

		// Batched / async mode
		if (is_int($response)) {
			return '';
		}

		// Sync mode
		if ($result['error']) {
			throw new Exception($result['error']);
		}

		$raw = $result['raw'];
		return $result['text'];
	}

	/**
	 * Detect alpha channel
	 */
	protected function imageHasAlpha($img)
	{
		if (!imageistruecolor($img)) return false;
		return imagecolortransparent($img) >= 0;
	}

	/**
	 * Normalize Gemini response into semantic text.
	 */
	protected function normalizeGeminiOutput(array $response)
	{
		if (empty($response['candidates'][0]['content']['parts'])) {
			return '';
		}

		$text = '';

		foreach ($response['candidates'][0]['content']['parts'] as $part) {
			if (isset($part['text']) && is_string($part['text'])) {
				$text .= $part['text'];
			}
		}

		return trim($text);
	}
}
