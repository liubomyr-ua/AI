<?php

/**
 * OpenAI Images API adapter for image generation and editing
 * @class
 * @implements AI_Image_Interface
 */
class AI_Image_Openai extends AI_Image implements AI_Image_Interface
{
	const JPEG_QUALITY = 85;

	/**
	 * Generates an image from a text prompt using the OpenAI Images API.
	 * Supports text-only generation or image-based edits/variations.
	 *
	 * @method generate
	 * @param {string} $prompt Description of the image to generate.
	 * @param {array} [$options=array()] Optional parameters:
	 *
	 * @param {string} [$options.model="gpt-image-1.5"] The model to use for generation.
	 *   Common values: "dall-e-3" (highest quality), "dall-e-2", "gpt-image-1.5" (default).
	 *
	 * @param {string} [$options.format="png"] Output image format.
	 *   Allowed: "png", "jpg", "jpeg", "webp". Defaults to "png".
	 *
	 * @param {string} [$options.size="1024x1024"] Desired image dimensions as "WIDTHxHEIGHT".
	 *   Can also be set via separate $options.width and $options.height (takes precedence over size).
	 *   Example: "1024x1024", "512x768", "1536x1536".
	 *
	 * @param {integer} [$options.width=1024] Image width in pixels (overrides size parameter).
	 *   Minimum: 64, recommended multiples of 64.
	 *
	 * @param {integer} [$options.height=1024] Image height in pixels (overrides size parameter).
	 *   Minimum: 64, recommended multiples of 64.
	 *
	 * @param {string} [$options.quality="auto"] Quality level (for DALL-E 3).
	 *   Allowed: "standard", "hd" (mapped to "auto"/"high" for API). Default: "auto".
	 *
	 * @param {array} [$options.images=array()] One or more existing images to use as reference or base.
	 *   When provided, triggers image-edit mode (mask-aware editing).
	 *   Each element should be binary image data or a path to an image file.
	 *   Supported formats: PNG (with optional alpha), JPEG, GIF, WebP.
	 *   Internally converted to PNG (if alpha) or JPEG (if opaque) for upload.
	 *   Example: array(file_get_contents('photo.jpg'), $binaryPngData)
	 *
	 * @param {callable} [$options.callback] Optional callback function to handle async responses.
	 *   Signature: function($result) where $result is ['data' => binary, 'format' => string] or ['error' => mixed].
	 *   Useful for batch mode or long-running requests.
	 *
	 * @param {integer} [$options.timeout=60] Request timeout in seconds. Default: 60.
	 *
	 * @return {array} Result array:
	 *   - Success: ['data' => binary image data, 'format' => string (e.g., 'png')]
	 *   - Error: ['error' => mixed (error message or decoded JSON response)]
	 *
	 * @example
	 *   // Text-to-image generation
	 *   $ai = new AI_Image_Openai();
	 *   $result = $ai->generate('A serene mountain landscape at sunset', [
	 *       'model' => 'dall-e-3',
	 *       'size' => '1024x1024',
	 *       'quality' => 'hd'
	 *   ]);
	 *   if (!empty($result['data'])) {
	 *       file_put_contents('output.png', $result['data']);
	 *   }
	 *
	 * @example
	 *   // Image-based editing using existing image as reference
	 *   $baseImage = file_get_contents('original.jpg');
	 *   $result = $ai->generate('Change the sky to deep purple', [
	 *       'images' => [$baseImage],
	 *       'format' => 'png',
	 *       'model' => 'dall-e-2'
	 *   ]);
	 *
	 * @example
	 *   // Batch mode with callback
	 *   $result = $ai->generate('Stylized portrait', [
	 *       'callback' => function($res) {
	 *           if (empty($res['error'])) {
	 *               file_put_contents('async_output.png', $res['data']);
	 *           }
	 *       }
	 *   ]);
	 */
	public function generate($prompt, $options = array())
	{
		$apiKey = Q_Config::expect('AI', 'openAI', 'key');

		$defaultModel = Q_Config::get(
			'AI',
			'images',
			'openai',
			'model',
			'gpt-image-1.5'
		);

		$model = Q::ifset($options, 'model', $defaultModel);
		$format  = strtolower(Q::ifset($options, 'format', 'png'));
		$timeout = Q::ifset($options, 'timeout', 60);

		$userCallback = Q::ifset($options, 'callback', null);

		// --- Size normalization: prioritize width/height over size parameter ---
		if (!empty($options['size']) && preg_match('/^(\d+)x(\d+)$/', $options['size'], $m)) {
			$size = $options['size'];
		} else {
			$w = Q::ifset($options, 'width', 1024);
			$h = Q::ifset($options, 'height', 1024);
			$size = "{$w}x{$h}";
		}

		$images   = Q::ifset($options, 'images', array());
		$useImage = is_array($images) && !empty($images);

		$result = array(
			'data'   => null,
			'format' => $format,
			'error'  => null
		);

		/**
		 * Transport-level callback for handling async and synchronous responses.
		 * Decodes base64 image data, handles format conversion, and invokes user callback.
		 */
		$callback = function ($info, $response) use (&$result, $format, $userCallback) {

			if (!is_string($response) || $response === '') {
				$result['error'] = 'Empty or invalid OpenAI response';
			} else {
				$data = json_decode($response, true);

				if (!is_array($data) || empty($data['data'][0]['b64_json'])) {
					$result['error'] = $data;
				} else {
					$pngBinary = base64_decode($data['data'][0]['b64_json'], true);
					if ($pngBinary === false) {
						$result['error'] = 'Failed to decode image data';
					} else {
						$converted = $this->convertFromPng($pngBinary, $format);
						if ($converted === false) {
							$result['error'] = 'Image format conversion failed';
						} else {
							$result['data'] = $converted;
						}
					}
				}
			}

			if ($userCallback && is_callable($userCallback)) {
				try {
					call_user_func($userCallback, $result);
				} catch (Exception $e) {
					error_log($e);
				}
			}
		};

		// ===== TEXT-ONLY GENERATION =====
		if (!$useImage) {

			$qualityMap = array(
				'standard' => 'auto',
				'hd'       => 'high'
			);
			$q = Q::ifset($options, 'quality', 'auto');
			$quality = Q::ifset($qualityMap, $q, $q);

			$payload = array(
				'model'   => $model,
				'prompt'  => $prompt,
				'size'    => $size,
				'quality' => $quality,
				'n'       => 1
			);

			$response = Q_Utils::post(
				'https://api.openai.com/v1/images/generations',
				json_encode($payload),
				null,
				false,
				array(
					"Authorization: Bearer $apiKey",
					"Content-Type: application/json"
				),
				$timeout,
				$callback
			);
		}

		// ===== IMAGE-BASED EDITING / VARIATIONS =====
		else {
			$raw = Q_Utils::toRawBinary(reset($images));
			if ($raw === false) {
				return array('error' => 'Invalid image input');
			}

			$encoded = $this->encodeForUpload($raw);
			if (!$encoded) {
				return array('error' => 'Image encoding failed');
			}

			$postFields = array(
				'model'  => $model,
				'prompt' => $prompt,
				'image'  => new CURLFile($encoded['path'], $encoded['mime']),
				'size'   => $size,
				'n'      => 1
			);

			$response = Q_Utils::post(
				'https://api.openai.com/v1/images/edits',
				$postFields,
				null,
				null,
				array(
					"Authorization: Bearer $apiKey",
					"Content-Type: multipart/form-data"
				),
				$timeout,
				$callback
			);

			@unlink($encoded['path']);
		}

		// Batch mode (callback was invoked asynchronously)
		if (is_int($response)) {
			return $result;
		}

		if ($result['error']) {
			return array('error' => $result['error']);
		}

		return $result;
	}

	/**
	 * Removes the background from an image using OpenAI image edits.
	 * Generates a prompt internally to isolate the subject on a transparent background.
	 *
	 * @method removeBackground
	 * @param {string|binary} $image The image to process. Can be binary data or file path.
	 * @param {array} [$options=array()] Optional parameters (see generate() for common options).
	 *   Additional options:
	 *   - @param {string} [$options.prompt="remove background"] Custom prompt for the edit.
	 *     Default guides OpenAI to isolate the subject cleanly.
	 *   - @param {string} [$options.format="png"] Output format (png supports transparency).
	 *     Recommended: "png" for transparency, "jpg" for opaque background.
	 *
	 * @return {array} Result array: ['data' => binary, 'format' => string] or ['error' => mixed].
	 *
	 * @example
	 *   $imageBinary = file_get_contents('portrait.jpg');
	 *   $result = $ai->removeBackground($imageBinary, ['format' => 'png']);
	 *   if (empty($result['error'])) {
	 *       file_put_contents('portrait_transparent.png', $result['data']);
	 *   }
	 */
	public function removeBackground($image, $options = array())
	{
		$options['images'] = array($image);
		$options['prompt'] = Q::ifset($options, 'prompt', 'remove background');

		return $this->generate($options['prompt'], $options);
	}

	/**
	 * Encodes an input image for upload to OpenAI API.
	 * Converts to JPEG for opaque images (smaller), PNG only if transparency needed.
	 * Rejects WebP (not supported by OpenAI).
	 *
	 * @private
	 * @method encodeForUpload
	 * @param {string} $binary Raw binary image data.
	 * @return {array|false} Array with keys 'path' (temp file) and 'mime' (MIME type),
	 *   or false if image cannot be decoded.
	 *
	 * @protected
	 */
	protected function encodeForUpload($binary)
	{
		$img = @imagecreatefromstring($binary);
		if (!$img) return false;

		$hasAlpha = $this->imageHasAlpha($img);

		if ($hasAlpha) {
			$tmp = tempnam(sys_get_temp_dir(), 'ai_img_') . '.png';
			imagepng($img, $tmp);
			imagedestroy($img);
			return array('path' => $tmp, 'mime' => 'image/png');
		}

		$tmp = tempnam(sys_get_temp_dir(), 'ai_img_') . '.jpg';
		imagejpeg($img, $tmp, self::JPEG_QUALITY);
		imagedestroy($img);
		return array('path' => $tmp, 'mime' => 'image/jpeg');
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

	/**
	 * Converts an OpenAI PNG response to the requested output format.
	 * For JPG output, composites PNG onto a white background (no transparency).
	 * For PNG/WebP, returns or converts as-is.
	 *
	 * @private
	 * @method convertFromPng
	 * @param {string} $pngBinary Binary PNG data from OpenAI API.
	 * @param {string} $format Target format: "png", "jpg", "jpeg", "webp".
	 * @return {string|false} Binary image data in requested format, or false on failure.
	 *
	 * @protected
	 */
	protected function convertFromPng($pngBinary, $format)
	{
		if ($format === 'png') {
			return $pngBinary;
		}

		$img = @imagecreatefromstring($pngBinary);
		if (!$img) return false;

		$w = imagesx($img);
		$h = imagesy($img);

		// For JPG: composite onto white background to remove alpha
		$canvas = imagecreatetruecolor($w, $h);
		$white = imagecolorallocate($canvas, 255, 255, 255);
		imagefill($canvas, 0, 0, $white);
		imagecopy($canvas, $img, 0, 0, 0, 0, $w, $h);

		ob_start();
		switch ($format) {
			case 'jpg':
			case 'jpeg':
				imagejpeg($canvas, null, self::JPEG_QUALITY);
				break;
			case 'webp':
				if (!function_exists('imagewebp')) {
					ob_end_clean();
					return false;
				}
				imagewebp($canvas, null, self::JPEG_QUALITY);
				break;
			default:
				ob_end_clean();
				return false;
		}
		$out = ob_get_clean();

		imagedestroy($img);
		imagedestroy($canvas);

		return $out;
	}
}