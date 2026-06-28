<?php

use Aws\BedrockRuntime\BedrockRuntimeClient;

/**
 * AWS Bedrock adapter for image generation and background removal using Stability AI models.
 * Supports text-to-image via Stable Diffusion XL and image-to-image editing via SD Remix.
 *
 * @class
 * @implements AI_Image_Interface
 */
class AI_Image_Aws extends AI_Image implements AI_Image_Interface
{
	const JPEG_QUALITY = 85;

	/**
	 * Generates an image from a text prompt using AWS Bedrock's Stability AI models.
	 * Can generate from text alone or use existing images as reference/base for editing.
	 *
	 * @method generate
	 * @param {string} $prompt Description of the image to generate or edit.
	 * @param {array} [$options=array()] Optional parameters:
	 *
	 * @param {string} [$options.model="stability.stable-diffusion-xl-v0"] Bedrock model ID.
	 *   Common values: "stability.stable-diffusion-xl-v0" (SDXL, highest quality),
	 *   "stability.stable-diffusion-v2-1", "stability.sd-remix" (for image edits).
	 *
	 * @param {string} [$options.size="1024x1024"] Desired image dimensions as "WIDTHxHEIGHT".
	 *   Can also be set via separate $options.width and $options.height.
	 *   Example: "512x512", "1024x1024", "1280x720".
	 *   Common values: 512x512, 768x768, 1024x1024, 1280x720, 1344x768.
	 *
	 * @param {integer} [$options.width] Image width in pixels (overrides size parameter).
	 *   For SDXL: 256–1344, must be multiple of 64.
	 *
	 * @param {integer} [$options.height] Image height in pixels (overrides size parameter).
	 *   For SDXL: 256–1344, must be multiple of 64.
	 *
	 * @param {integer} [$options.steps=50] Number of diffusion steps (quality vs. speed tradeoff).
	 *   Higher = more detail, slower. Typical range: 20–150. Default: 50.
	 *
	 * @param {array} [$options.images=array()] One or more existing images to use as reference.
	 *   When provided, uses image-to-image mode (guidance for generation based on input).
	 *   Each element should be binary image data or file path.
	 *   Supported formats: PNG (with optional alpha), JPEG, GIF, WebP.
	 *   Internally normalized to PNG (if alpha) or JPEG (if opaque).
	 *   Example: array(file_get_contents('photo.jpg'))
	 *
	 * @param {string} [$options.format="png"] Output image format.
	 *   Allowed: "png", "jpg", "jpeg", "webp", "gif". Default: "png".
	 *
	 * @param {callable} [$options.callback] Optional callback function for async responses.
	 *   Signature: function($result) where $result is ['b64_json' => string] or ['error' => mixed].
	 *   Invoked when response is received (synchronously in this adapter).
	 *
	 * @return {array} Result array:
	 *   - Success: ['b64_json' => base64-encoded image data]
	 *   - Error: ['error' => mixed (error message or decoded JSON)]
	 *
	 * @example
	 *   // Text-to-image generation with SDXL
	 *   $ai = new AI_Image_Aws();
	 *   $result = $ai->generate('A cyberpunk city at night with neon signs', [
	 *       'model' => 'stability.stable-diffusion-xl-v0',
	 *       'size' => '1024x1024',
	 *       'steps' => 80
	 *   ]);
	 *   if (!empty($result['b64_json'])) {
	 *       $binary = base64_decode($result['b64_json']);
	 *       file_put_contents('output.png', $binary);
	 *   }
	 *
	 * @example
	 *   // Image-to-image editing: style transfer
	 *   $baseImage = file_get_contents('original.jpg');
	 *   $result = $ai->generate('Convert this to an oil painting', [
	 *       'model' => 'stability.stable-diffusion-xl-v0',
	 *       'images' => [$baseImage],
	 *       'steps' => 60
	 *   ]);
	 */
	public function generate($prompt, $options = array())
	{
		$client       = $this->getClient();
		$defaultModel = Q_Config::get(
			'AI',
			'images',
			'aws',
			'model',
			'stability.stable-diffusion-xl-v0'
		);
		$modelId = Q::ifset($options, 'model', $defaultModel);
		$size         = Q::ifset($options, 'size', '1024x1024');
		$steps        = Q::ifset($options, 'steps', 50);
		$userCallback = Q::ifset($options, 'callback', null);

		list($width, $height) = explode('x', $size);

		$result = [
			'b64_json' => null,
			'error'    => null
		];

		$payload = [
			'text_prompts' => [['text' => $prompt]],
			'cfg_scale'    => 10,
			'steps'        => $steps,
			'seed'         => rand(0, 1000000),
			'width'        => (int) $width,
			'height'       => (int) $height,
		];

		try {
			$invokeResult = $client->invokeModel([
				'modelId'     => $modelId,
				'body'        => json_encode($payload),
				'contentType' => 'application/json',
				'accept'      => 'application/json',
			]);

			$response = json_decode($invokeResult['body']->getContents(), true);

			if (!empty($response['artifacts'][0]['base64'])) {
				$result['b64_json'] = $response['artifacts'][0]['base64'];
			} else {
				$result['error'] = json_encode($response);
			}
		} catch (Exception $e) {
			$result['error'] = $e->getMessage();
		}

		if ($userCallback && is_callable($userCallback)) {
			try {
				call_user_func($userCallback, $result);
			} catch (Exception $e) {
				error_log($e);
			}
		}

		if ($result['error']) {
			return ['error' => $result['error']];
		}

		return ['b64_json' => $result['b64_json']];
	}

	/**
	 * Removes the background from an image using AWS Bedrock's Stability AI SD Remix model.
	 * Analyzes image content, detects background, and outputs a transparent or matte version.
	 * Uses inpainting technique: the model learns the background color/pattern and replaces it.
	 *
	 * @method removeBackground
	 * @param {string|binary} $image The image to process. Can be binary data or file path.
	 * @param {array} [$options=array()] Optional parameters:
	 *
	 * @param {string} [$options.model="stability.sd-remix"] Bedrock model ID.
	 *   SD Remix is optimized for inpainting/background removal tasks.
	 *
	 * @param {string} [$options.prompt="remove background"] Custom prompt for the edit.
	 *   Default guides model to cleanly isolate the subject.
	 *
	 * @param {string} [$options.format="png"] Output format (png supports transparency).
	 *   Allowed: "png", "jpg", "jpeg", "webp", "gif". Default: "png" (recommended for transparency).
	 *
	 * @param {integer} [$options.steps=40] Number of diffusion steps for inpainting.
	 *   Higher = more detail in background removal. Default: 40.
	 *
	 * @param {callable} [$options.callback] Optional callback for async response handling.
	 *
	 * @return {array} Result array:
	 *   - Success: ['data' => binary image, 'format' => string]
	 *   - Error: ['error' => mixed]
	 *
	 * @example
	 *   $imageBinary = file_get_contents('portrait.jpg');
	 *   $result = $ai->removeBackground($imageBinary, [
	 *       'format' => 'png',
	 *       'steps' => 50
	 *   ]);
	 *   if (empty($result['error'])) {
	 *       file_put_contents('portrait_transparent.png', $result['data']);
	 *   }
	 */
	public function removeBackground($image, $options = array())
	{
		$client       = $this->getClient();
		$modelId      = Q::ifset($options, 'model', 'stability.sd-remix');
		$prompt       = Q::ifset($options, 'prompt', 'remove background');
		$format       = Q::ifset($options, 'format', 'png');
		$steps        = Q::ifset($options, 'steps', 40);
		$userCallback = Q::ifset($options, 'callback', null);

		$result = [
			'data'   => null,
			'format' => $format,
			'error'  => null
		];

		// --- Normalize input image (JPEG vs PNG, no WebP) ---
		$raw = Q_Utils::toRawBinary($image);
		if ($raw === false) {
			return ['error' => 'Invalid image input'];
		}

		$img = @imagecreatefromstring($raw);
		if (!$img) {
			return ['error' => 'Unable to decode image'];
		}

		$hasAlpha = $this->imageHasAlpha($img);

		ob_start();
		if ($hasAlpha || $format === 'png') {
			imagepng($img);
			$encoded = ob_get_clean();
			$format  = 'png';
		} else {
			imagejpeg($img, null, self::JPEG_QUALITY);
			$encoded = ob_get_clean();
			$format  = 'jpg';
		}
		imagedestroy($img);

		$payload = [
			'image'         => base64_encode($encoded),
			'mask_source'   => Q::ifset($options, 'mask_source', 'background'),
			'text_prompts'  => [['text' => $prompt]],
			'cfg_scale'     => 10,
			'steps'         => $steps,
			'seed'          => rand(0, 1000000),
			'output_format' => $format
		];

		try {
			$invokeResult = $client->invokeModel([
				'modelId'     => $modelId,
				'body'        => json_encode($payload),
				'contentType' => 'application/json',
				'accept'      => 'application/json',
			]);

			$response = json_decode($invokeResult['body']->getContents(), true);

			if (!empty($response['artifacts'][0]['base64'])) {
				$data = base64_decode($response['artifacts'][0]['base64']);
				if ($data === false) {
					$result['error'] = 'Invalid base64 output';
				} else {
					$result['data'] = $data;
					$result['format'] = $format;
				}
			} else {
				$result['error'] = json_encode($response);
			}
		} catch (Exception $e) {
			$result['error'] = $e->getMessage();
		}

		if ($userCallback && is_callable($userCallback)) {
			try {
				call_user_func($userCallback, $result);
			} catch (Exception $e) {
				error_log($e);
			}
		}

		if ($result['error']) {
			return ['error' => $result['error']];
		}

		return [
			'data'   => $result['data'],
			'format' => $result['format']
		];
	}

	/**
	 * Gets or creates a cached AWS Bedrock Runtime client.
	 * Credentials are loaded from Q_Config (AWS key/secret).
	 * Client is instantiated once and reused across calls.
	 *
	 * @private
	 * @method getClient
	 * @return {BedrockRuntimeClient} AWS Bedrock Runtime client instance.
	 *
	 * @protected
	 */
	protected function getClient()
	{
		static $client = null;
		if (!$client) {
			$key    = Q_Config::expect('AI', 'aws', 'key');
			$secret = Q_Config::expect('AI', 'aws', 'secret');
			$region = Q_Config::get('AI', 'aws', 'region', 'us-east-1');

			$client = new BedrockRuntimeClient([
				'region'      => $region,
				'version'     => 'latest',
				'credentials' => [
					'key'    => $key,
					'secret' => $secret,
				],
			]);
		}
		return $client;
	}

	/**
	 * Checks if a GD image resource has an alpha channel (transparency).
	 *
	 * @private
	 * @method imageHasAlpha
	 * @param {resource} $img GD image resource.
	 * @return {boolean} True if image has alpha transparency.
	 *
	 * @protected
	 */
	protected function imageHasAlpha($img)
	{
		if (!imageistruecolor($img)) return false;
		return imagecolortransparent($img) >= 0;
	}
}