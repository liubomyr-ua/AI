<?php

/**
 * Google Vertex AI adapter for image generation and background removal via proxy.
 * Communicates with a Node.js Vertex proxy server (see proxy documentation).
 * Supports text-to-image generation with optional reference images for guided generation.
 *
 * @class
 * @implements AI_Image_Interface
 */
class AI_Image_Google extends AI_Image implements AI_Image_Interface
{
	const JPEG_QUALITY = 85;

	/**
	 * Generates an image from a text prompt using Google Vertex AI via proxy.
	 * Supports pure text-to-image or image-guided generation with reference images.
	 * Requests are signed with HMAC-SHA256 and transmitted to the proxy server.
	 *
	 * @method generate
	 * @param {string} $prompt Description of the image to generate or desired edits.
	 * @param {array} [$options=array()] Optional parameters:
	 *
	 * @param {string} [$options.format="png"] Output image format.
	 *   Allowed: "png", "jpg", "jpeg", "webp", "gif". Default: "png".
	 *   Note: Format conversion happens on proxy server using Sharp.
	 *
	 * @param {integer} [$options.width=1024] Image width in pixels.
	 *   Recommended: 512–2048, typical: 1024, 1280, 1536. Default: 1024.
	 *
	 * @param {integer} [$options.height=1024] Image height in pixels.
	 *   Recommended: 512–2048, typical: 1024, 1280, 1536. Default: 1024.
	 *
	 * @param {string} [$options.size=""] Alternative to width/height: "WIDTHxHEIGHT" format.
	 *   If provided, overrides width and height parameters.
	 *   Example: "1200x630", "1920x1080". Max dimension: 4096px.
	 *
	 * @param {string} [$options.background="none"] Background handling mode.
	 *   Allowed: "none" (keep original), "transparent" (remove bg, PNG only), "gradient" (add gradient).
	 *   Default: "none" (original background preserved).
	 *   - "transparent": Outputs RGBA PNG with transparent background.
	 *   - "gradient": Composites subject over a teal-to-blue gradient background.
	 *
	 * @param {integer} [$options.feather=20] Feather radius for transparent background edges (pixels).
	 *   Only applies when background="transparent". Smooths alpha mask edges.
	 *   Range: 0–100. Default: 20. Ignored for background="none" or "gradient".
	 *
	 * @param {string} [$options.bgColor] Custom background color for transparent mode.
	 *   Accepts hex (e.g., "#f2f2f2") or RGB format. Default: "#f2f2f2" (light gray).
	 *   Used to guide prompt for cleaner subject isolation.
	 *
	 * @param {array} [$options.images=array()] One or more existing images to use as reference.
	 *   When provided, guides generation based on image content (style transfer, outpainting, etc.).
	 *   Each element should be binary image data or file path.
	 *   Supported formats: PNG (with optional alpha), JPEG, GIF, WebP.
	 *   Internally converted to JPEG for efficient upload (up to 5 images).
	 *   Example: array(file_get_contents('photo.jpg'), $binaryPngData)
	 *   Reference in prompt as: "photo 1", "photo 2", etc.
	 *
	 * @param {callable} [$options.callback] Optional callback function for async response handling.
	 *   Signature: function($result) where $result is ['data' => binary, 'format' => string] or ['error' => mixed].
	 *   Useful for batch processing or long-running requests.
	 *
	 * @param {integer} [$options.timeout=60] Request timeout in seconds. Default: 60.
	 *   Increase for large images or complex prompts.
	 *
	 * @return {array} Result array:
	 *   - Success: ['data' => binary image data, 'format' => string (e.g., 'png')]
	 *   - Batch (callback): ['data' => null, 'format' => string] (result passed to callback)
	 *   - Error: ['error' => mixed (error message or JSON response)]
	 *
	 * @example
	 *   // Text-to-image generation (pure generation)
	 *   $ai = new AI_Image_Google();
	 *   $result = $ai->generate('A serene Japanese garden with koi pond and stone lanterns', [
	 *       'format' => 'png',
	 *       'width' => 1024,
	 *       'height' => 1024
	 *   ]);
	 *   if (empty($result['error'])) {
	 *       file_put_contents('garden.png', $result['data']);
	 *   }
	 *
	 * @example
	 *   // Generate with transparent background
	 *   $result = $ai->generate('Portrait of a woman, professional headshot', [
	 *       'background' => 'transparent',
	 *       'format' => 'png',
	 *       'feather' => 15,
	 *       'bgColor' => '#ffffff'
	 *   ]);
	 *
	 * @example
	 *   // Image-guided generation using reference image
	 *   $referenceImage = file_get_contents('style_reference.jpg');
	 *   $result = $ai->generate('Paint this scene in the style of photo 1 but with a sunset', [
	 *       'images' => [$referenceImage],
	 *       'width' => 1536,
	 *       'height' => 1024,
	 *       'background' => 'transparent'
	 *   ]);
	 *
	 * @example
	 *   // Batch mode with callback
	 *   $result = $ai->generate('Stylized portrait', [
	 *       'callback' => function($res) {
	 *           if (empty($res['error'])) {
	 *               file_put_contents('async_output.png', $res['data']);
	 *               echo "Generated: " . strlen($res['data']) . " bytes\\n";
	 *           } else {
	 *               echo "Error: " . $res['error'] . "\\n";
	 *           }
	 *       },
	 *       'timeout' => 120
	 *   ]);
	 */
	public function generate($prompt, $options = array())
	{
		$proxyUrl = rtrim(Q_Config::expect('AI', 'google', 'url'), '/');
		$clientId = Q_Config::expect('AI', 'google', 'clientId');
		$secret   = Q_Config::expect('AI', 'google', 'secret');

		$userCallback = Q::ifset($options, 'callback', null);
		$timestamp = time();

		$background = Q::ifset($options, 'background', 'none');
		$feather    = Q::ifset($options, 'feather', 0);

		// Feather only applies to transparency
		if ($background !== 'transparent') {
			$feather = 0;
		}

		$postFields = array(
			'prompt'     => $prompt,
			'format'     => Q::ifset($options, 'format', 'png'),
			'width'      => Q::ifset($options, 'width', 1024),
			'height'     => Q::ifset($options, 'height', 1024),
			'background' => $background,
			'feather'    => $feather
		);

		// Handle bgColor if provided and background is transparent
		if ($background === 'transparent' && !empty($options['bgColor'])) {
			$postFields['bgColor'] = $options['bgColor'];
		}

		foreach ($postFields as $k => $v) {
			if ($v === null) unset($postFields[$k]);
		}

		// --- Signature (clientId + timestamp only) ---
		$signature = hash_hmac(
			'sha256',
			$clientId . $timestamp,
			$secret
		);

		$headers = array(
			"X-Client-ID: $clientId",
			"X-Timestamp: $timestamp",
			"X-Signature: $signature",
			"Content-Type: multipart/form-data"
		);

		// === Attach images (optional, up to 5) ===
		$tmpFiles = array();
		$images = Q::ifset($options, 'images', array());

		if (is_array($images)) {
			foreach (array_slice($images, 0, 5) as $i => $binary) {

				$raw = Q_Utils::toRawBinary($binary);
				if ($raw === false) continue;

				$img = @imagecreatefromstring($raw);
				if (!$img) continue;

				$hasAlpha = $this->imageHasAlpha($img);

				if ($hasAlpha) {
					$tmp = tempnam(sys_get_temp_dir(), 'ai_img_') . '.png';
					imagepng($img, $tmp);
					$mime = 'image/png';
				} else {
					$tmp = tempnam(sys_get_temp_dir(), 'ai_img_') . '.jpg';
					imagejpeg($img, $tmp, self::JPEG_QUALITY);
					$mime = 'image/jpeg';
				}

				imagedestroy($img);

				$postFields['photo' . ($i + 1)] =
					new CURLFile($tmp, $mime);

				$tmpFiles[] = $tmp;
			}
		}

		$result = array(
			'data'   => null,
			'format' => Q::ifset($postFields, 'format', 'png'),
			'error'  => null
		);

		$callback = function ($info, $response) use (
			&$result,
			$userCallback,
			$tmpFiles
		) {
			foreach ($tmpFiles as $tmp) {
				@unlink($tmp);
			}

			$httpCode = Q::ifset($info, 'http_code', 0);

			if ($httpCode >= 200 && $httpCode < 300 && is_string($response)) {
				$result['data'] = $response;
			} else {
				if (is_string($response)) {
					$json = json_decode($response, true);
					$result['error'] = $json ? $json : $response;
				} else {
					$result['error'] = 'Invalid proxy response';
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

		$response = Q_Utils::post(
			$proxyUrl . '/generate',
			$postFields,
			null,
			null,
			$headers,
			Q::ifset($options, 'timeout', 60),
			$callback
		);

		if (is_int($response)) {
			return $result;
		}

		if ($result['error']) {
			return array('error' => $result['error']);
		}

		return $result;
	}

	/**
	 * Removes the background from an image using Google Vertex AI via proxy.
	 * Generates a prompt internally to isolate the subject on a transparent background.
	 * The proxy server handles edge feathering and alpha channel optimization.
	 *
	 * @method removeBackground
	 * @param {string|binary} $image The image to process. Can be binary data or file path.
	 * @param {array} [$options=array()] Optional parameters (see generate() for common options).
	 *   Additional/notable options:
	 *   - @param {string} [$options.prompt="remove background"] Custom prompt for subject isolation.
	 *     Default guides model to cleanly remove background and preserve subject details.
	 *   - @param {string} [$options.format="png"] Output format (png supports transparency).
	 *     Recommended: "png" for transparency, "jpg" for opaque composite.
	 *   - @param {integer} [$options.feather=20] Alpha feathering for smooth edges (pixels).
	 *     Higher values = smoother but less precise edges. Default: 20.
	 *   - @param {string} [$options.bgColor="#f2f2f2"] Hint color for background detection.
	 *     Used to guide the model. Example: "#ffffff" (white).
	 *
	 * @return {array} Result array: ['data' => binary, 'format' => string] or ['error' => mixed].
	 *
	 * @example
	 *   $imageBinary = file_get_contents('portrait.jpg');
	 *   $result = $ai->removeBackground($imageBinary, [
	 *       'format' => 'png',
	 *       'feather' => 25,
	 *       'bgColor' => '#ffffff'
	 *   ]);
	 *   if (empty($result['error'])) {
	 *       file_put_contents('portrait_transparent.png', $result['data']);
	 *   }
	 */
	public function removeBackground($image, $options = array())
	{
		$options['images'] = array($image);
		$options['background'] = 'transparent';

		return $this->generate(
			Q::ifset($options, 'prompt', 'remove background'),
			$options
		);
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