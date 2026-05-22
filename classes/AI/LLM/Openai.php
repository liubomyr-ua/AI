<?php

class AI_LLM_Openai extends AI_LLM implements AI_LLM_Interface
{
	protected $model;

	function __construct()
	{
		$defaultModel = 'gpt-4.1-mini';

		$this->model = Q_Config::get(
			'AI',
			'llm',
			'models',
			'openai',
			$defaultModel
		);
	}

	/**
	 * Execute a model call using OpenAI's Responses API.
	 */
	public function executeModel($instructions, array $inputs, array $options = array(), &$raw = null)
	{
		$apiKey = Q_Config::expect('AI', 'openAI', 'key');

		$model = Q::ifset($options, 'model', $this->model);

		$headers = array(
			"Content-Type: application/json",
			"Authorization: Bearer $apiKey"
		);

		/**
		 * Build multimodal user content
		 */
		$content = array();

		if (!empty($inputs['text'])) {
			$content[] = array(
				'type' => 'input_text',
				'text' => $inputs['text']
			);
		}

		/**
		 * Multimodal images
		 * - Preserve JPEG / PNG
		 * - Never send WebP
		 * - Correct MIME in data URL
		 */
		if (!empty($inputs['images']) && is_array($inputs['images'])) {
			foreach ($inputs['images'] as $binary) {

				$rawBinary = Q_Utils::toRawBinary($binary);
				if ($rawBinary === false) {
					continue;
				}

				$img = @imagecreatefromstring($rawBinary);
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

				$content[] = array(
					'type' => 'input_image',
					'image_url' => 'data:' . $mime . ';base64,' . base64_encode($data)
				);
			}
		}

		/**
		 * Build message timeline
		 */
		$messages = array();

		if (!empty($options['messages']) && is_array($options['messages'])) {

			foreach ($options['messages'] as $msg) {

				$role = Q::ifset($msg, 'role', 'user');
				$contentMsg = Q::ifset($msg, 'content', '');

				if (is_string($contentMsg)) {
					$contentMsg = array(
						array(
							'type' => 'input_text',
							'text' => $contentMsg
						)
					);
				}

				$messages[] = array(
					'role' => $role,
					'content' => $contentMsg
				);
			}

		} else {

			/**
			 * Legacy behaviour (existing adapter behavior)
			 */
			$userContent = array();

			foreach ($content as $c) {
				$userContent[] = $c;
			}

			$messages[] = array(
				'role' => 'user',
				'content' => $userContent
			);
		}

		/**
		 * Payload
		 */
		$payload = array(
			'model' => $model,
			'input' => $messages,
			'max_output_tokens' => Q::ifset($options, 'max_tokens', 3000),
			'temperature' => Q::ifset($options, 'temperature', 0.5)
		);

		/**
		 * System instructions
		 */
		if (!empty($instructions)) {
			$payload['instructions'] = $instructions;
		}

		/**
		 * Structured output support
		 */
		$responseFormat = Q::ifset($options, 'response_format', null);
		$jsonSchema = Q::ifset($options, 'json_schema', null);

		if ($responseFormat === 'json_schema' && is_array($jsonSchema)) {

			$payload['response_format'] = array(
				'type' => 'json_schema',
				'json_schema' => $jsonSchema
			);

		} elseif ($responseFormat === 'json') {

			$payload['response_format'] = array(
				'type' => 'json_object'
			);

		} elseif (!empty($responseFormat)) {

			$payload['response_format'] = $responseFormat;
		}

		$callback = Q::ifset($options, 'callback', null);

		$response = Q_Utils::post(
			'https://api.openai.com/v1/responses',
			$payload,
			null,
			null,
			$headers,
			Q::ifset($options, 'timeout', 300),
			$callback
				? function ($info, $body) use ($callback, &$raw) {

					$decoded = json_decode($body, true);
					if (!is_array($decoded)) {
						throw new Exception("Invalid Responses API envelope");
					}

					$raw = $decoded;
					$result = $this->normalizeResponsesOutput($decoded);

					call_user_func($callback, $result, $decoded, $info);
				}
				: null
		);

		// Batched mode
		if ($callback) {
			return $response;
		}

		// Non-batched mode
		$decoded = json_decode($response, true);
		if (!is_array($decoded)) {
			throw new Exception("Invalid Responses API envelope");
		}

		$raw = $decoded;
		return $this->normalizeResponsesOutput($decoded);
	}

	/**
	 * Detect alpha channel
	 */
	protected function imageHasAlpha($img)
	{
		if (!imageistruecolor($img)) {
			return false;
		}

		// Check if there's a transparent color index (for palette images)
		if (imagecolortransparent($img) >= 0) {
			return true;
		}

		// Scan pixels for alpha values
		$width = imagesx($img);
		$height = imagesy($img);

		for ($x = 0; $x < $width; $x++) {
			for ($y = 0; $y < $height; $y++) {
				$rgba = imagecolorat($img, $x, $y);
				$alpha = ($rgba & 0x7F000000) >> 24;

				if ($alpha > 0) {
					return true;
				}
			}
		}

		return false;
	}

	/**
	 * Normalize OpenAI Responses output into semantic text.
	 */
	protected function normalizeResponsesOutput(array $response)
	{
		if (empty($response['output']) || !is_array($response['output'])) {
			return '';
		}

		foreach ($response['output'] as $item) {

			if (Q::ifset($item, 'type', null) !== 'message') {
				continue;
			}

			if (empty($item['content']) || !is_array($item['content'])) {
				continue;
			}

			$out = '';

			foreach ($item['content'] as $block) {

				if (
					isset($block['type']) &&
					$block['type'] === 'output_text' &&
					isset($block['text']) &&
					is_string($block['text'])
				) {
					$out .= $block['text'] . "\n";
				}
			}

			return trim($out);
		}

		return '';
	}
}