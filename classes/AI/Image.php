<?php

/**
 * Interface for AI-powered image generation and processing.
 * Defines contract for image generation, editing, and background removal across providers
 * (OpenAI, AWS Bedrock, Google Vertex AI, etc.).
 *
 * @interface
 */
interface AI_Image_Interface
{
	/**
	 * Generates an image from a text prompt using an AI model.
	 * May optionally accept reference images to guide generation (style transfer, outpainting, etc.).
	 * Each provider implementation defines its own specific options and capabilities.
	 *
	 * @method generate
	 * @param {string} $prompt The prompt describing the image to generate or desired edits.
	 *   Examples: "A serene mountain landscape", "Change the background to ocean waves",
	 *   "Paint in the style of photo 1 but with different lighting".
	 *
	 * @param {array} [$options=array()] Optional parameters controlling generation behavior.
	 *   See specific adapter documentation for full option reference. Common parameters:
	 *   - @param {string} [$options.model] Override default model for the provider.
	 *   - @param {string} [$options.format="png"] Output format: "png", "jpg", "webp", "gif", etc.
	 *   - @param {integer} [$options.width=1024] Image width in pixels (adapter-dependent).
	 *   - @param {integer} [$options.height=1024] Image height in pixels (adapter-dependent).
	 *   - @param {array} [$options.images] Reference images (binary data) to guide generation.
	 *   - @param {callable} [$options.callback] Callback for async/batch operation results.
	 *   - @param {integer} [$options.timeout=60] Request timeout in seconds.
	 *
	 * @return {array} Response array. Structure varies by adapter but generally includes:
	 *   - Success: ['data' => binary image data, 'format' => string] or ['b64_json' => base64 string]
	 *   - Error: ['error' => mixed (error message, exception, or decoded response)]
	 *   Callbacks receive the same array structure when async (batch mode).
	 *
	 * @throws {Q_Exception} May throw for configuration errors (missing API keys, bad config).
	 */
	public function generate($prompt, $options = array());

	/**
	 * Removes the background from an image, isolating the subject.
	 * Outputs are typically transparent (PNG/WebP) or composited onto a solid/gradient background.
	 * The specific background removal technique depends on the provider's model capabilities.
	 *
	 * @method removeBackground
	 * @param {string|binary} $image The image to process.
	 *   Can be raw binary data (from file_get_contents), file path, or other format
	 *   supported by Q_Utils::toRawBinary().
	 *   Supported input formats: PNG, JPEG, GIF, WebP (adapter-dependent).
	 *
	 * @param {array} [$options=array()] Optional parameters (see generate() for common options).
	 *   Additional relevant options:
	 *   - @param {string} [$options.prompt] Override the default background-removal prompt.
	 *   - @param {string} [$options.format="png"] Output format; "png" recommended for transparency.
	 *   - @param {string} [$options.background="transparent"] Background mode (Google provider).
	 *   - @param {integer} [$options.feather=20] Alpha feathering for smooth edges (Google provider).
	 *
	 * @return {array} Result array:
	 *   - Success: ['data' => binary image (typically PNG/RGBA), 'format' => string]
	 *   - Error: ['error' => mixed]
	 */
	public function removeBackground($image, $options = array());
}

/**
 * Base implementation for AI_Image_Interface.
 * Provides common factory method, prompt generation utilities, and throws NotImplemented for interface methods.
 * Subclass to implement provider-specific behavior (OpenAI, AWS Bedrock, Google Vertex AI).
 *
 * @class
 * @implements AI_Image_Interface
 */
class AI_Image implements AI_Image_Interface
{
	/**
	 * Curated list of 100 recognizable animals for fallback face generation.
	 * Used when input is not a face or NSFW content is detected.
	 * Covers diverse categories: mammals, birds, reptiles, aquatic, insects.
	 *
	 * @static
	 * @private
	 * @type array
	 */
	private static $ANIMALS = array(
		// Domestic & Farm
		'cat', 'dog', 'mouse', 'rabbit', 'hamster', 'guinea pig', 'horse',
		'cow', 'pig', 'sheep', 'goat', 'donkey', 'chicken', 'duck',
		
		// Wild Mammals - Predators
		'lion', 'tiger', 'leopard', 'jaguar', 'cheetah', 'cougar', 'wolf',
		'fox', 'hyena', 'jackal', 'bear', 'polar bear', 'grizzly bear',
		'panda', 'koala', 'kangaroo', 'wallaby',
		
		// Wild Mammals - Herbivores & Others
		'elephant', 'giraffe', 'zebra', 'rhinoceros', 'hippopotamus',
		'buffalo', 'antelope', 'deer', 'moose', 'reindeer', 'camel',
		'llama', 'alpaca', 'emu', 'ostrich',
		
		// Primates
		'monkey', 'chimpanzee', 'gorilla', 'orangutan', 'baboon', 'lemur',
		
		// Birds
		'eagle', 'hawk', 'owl', 'penguin', 'flamingo', 'peacock', 'parrot',
		'raven', 'crow', 'swan', 'goose', 'hummingbird', 'woodpecker',
		'cardinal', 'sparrow', 'toucan', 'stork', 'crane',
		
		// Reptiles & Amphibians
		'snake', 'lizard', 'crocodile', 'alligator', 'turtle', 'tortoise',
		'frog', 'toad', 'salamander', 'dragon', 'gecko', 'chameleon',
		
		// Sea & Aquatic Mammals
		'whale', 'dolphin', 'seal', 'sea lion', 'manatee', 'walrus', 'otter',
		
		// Fish
		'shark', 'goldfish', 'salmon', 'tuna', 'clownfish',
		
		// Insects
		'butterfly', 'bee', 'ant', 'beetle', 'ladybug', 'dragonfly',
		
		// Mythical/Stylized
		'dragon', 'phoenix', 'unicorn', 'griffin'
	);

	/**
	 * Default (abstract) implementation of generate.
	 * Throws Q_Exception_NotImplemented—subclasses must override this method.
	 *
	 * @method generate
	 * @param {string} $prompt
	 * @param {array} [$options=array()]
	 * @return {array}
	 * @throws {Q_Exception_NotImplemented}
	 *
	 * @protected
	 */
	public function generate($prompt, $options = array())
	{
		throw new Q_Exception_NotImplemented(array(
			'functionality' => 'AI_Image::generate'
		));
	}

	/**
	 * Default (abstract) implementation of removeBackground.
	 * Throws Q_Exception_NotImplemented—subclasses must override this method.
	 *
	 * @method removeBackground
	 * @param {string|binary} $image
	 * @param {array} [$options=array()]
	 * @return {array}
	 * @throws {Q_Exception_NotImplemented}
	 *
	 * @protected
	 */
	public function removeBackground($image, $options = array())
	{
		throw new Q_Exception_NotImplemented(array(
			'functionality' => 'AI_Image::removeBackground'
		));
	}

	/**
	 * Generates a smart prompt for face image generation and background removal.
	 * Intelligently handles three cases:
	 * 1. Complete visible face → center and remove background, preserve face
	 * 2. Partial/obscured face → generate full face close to original, remove background
	 * 3. Non-face input (NSFW, objects, animals) → generate cute animal face instead
	 *
	 * Returns a unified prompt that works across all providers (OpenAI, AWS, Google).
	 * Designed for use with `generate($prompt, ['images' => [$photo], 'background' => 'transparent'])`.
	 *
	 * @static
	 * @method promptFace
	 * @param {string} [$default=null] Default animal name for non-face fallback.
	 *   When input is not a face, generates a cute face of this animal instead.
	 *   If null, randomly selects from 100 curated recognizable animals.
	 *   Example: "cat", "dog", "fox", "polar bear", "penguin", "unicorn".
	 *   Invalid names are silently ignored, animal selection proceeds randomly.
	 *
	 * @return {string} Multi-case prompt optimized for face detection, generation, and background removal.
	 *   Prompt covers all three scenarios in a single unified instruction for maximum provider compatibility.
	 *   Output guarantees: face in center, background removed, high quality.
	 *
	 * @example
	 *   // Automatic animal selection (random from 100 curated list)
	 *   $prompt = AI_Image::promptFace();
	 *   $result = $ai->generate($prompt, [
	 *       'images' => [$photoData],
	 *       'background' => 'transparent'
	 *   ]);
	 *
	 * @example
	 *   // Specific animal fallback for consistent branding
	 *   $prompt = AI_Image::promptFace('cat');
	 *   $result = $ai->generate($prompt, [
	 *       'images' => [file_get_contents('user_photo.jpg')],
	 *       'format' => 'png',
	 *       'background' => 'transparent'
	 *   ]);
	 *
	 * @example
	 *   // Use with Google adapter for best results (native transparency support)
	 *   $ai = AI_Image::create('google');
	 *   $userPhoto = $_FILES['photo']['tmp_name'];
	 *   $result = $ai->generate(
	 *       AI_Image::promptFace('fox'),
	 *       [
	 *           'images' => [file_get_contents($userPhoto)],
	 *           'background' => 'transparent',
	 *           'feather' => 20
	 *       ]
	 *   );
	 *
	 * @example
	 *   // Fallback handling: NSFW or non-face input → cute animal instead
	 *   // Input: NSFW image → Output: cute cat face (if default='cat')
	 *   // Input: random object photo → Output: cute dog face (if default='dog')
	 *   // Input: partial/low-quality face → Output: full clear face similar to input
	 */
	public static function promptFace($default = null)
	{
		// Select animal: use $default if valid, else random from curated list
		if ($default && in_array(strtolower($default), self::$ANIMALS)) {
			$animal = strtolower($default);
		} else {
			$animal = self::$ANIMALS[array_rand(self::$ANIMALS)];
		}

		return "If the person's face is completely visible, center it in the photo and remove background, "
			. "without changing the face. "
			. "If the face is not completely visible, then generate a photo of their face in the center, "
			. "as close as possible to what they look like, with background removed. "
			. "If the input image is not a face at all, then generate the detailed face of a cute $animal, "
			. "in the middle, with background removed. "
			. "Either way, the output is the face in the center, with no background.";
	}

	/**
	 * Factory method to create or resolve an AI image adapter instance.
	 * Handles string names (normalized to class names), full class names, and existing instances.
	 * Adapter class names follow convention: AI_Image_<AdapterName> (e.g., AI_Image_Openai).
	 *
	 * @method create
	 * @static
	 * @param {string|object} $adapter Adapter specification:
	 *   - String (short name): "openai", "aws", "google", "open-ai", etc.
	 *     Normalized to class name (e.g., "open_ai" → "AI_Image_OpenAi").
	 *   - String (full class name): "AI_Image_Openai" or "Some\Custom\AI_Image".
	 *     Used directly if class exists.
	 *   - Object: Existing adapter instance returned as-is.
	 *   - Null/empty: Returns null.
	 *
	 * @param {array} [$options=array()] Optional constructor parameters passed to adapter class.
	 *   Format depends on adapter implementation (usually configuration or state).
	 *
	 * @return {object|null} Instance of adapter implementing AI_Image_Interface,
	 *   or null if adapter not found (adapter not installed or autoloader misconfigured).
	 *
	 * @example
	 *   // Create OpenAI adapter (short name, auto-normalized)
	 *   $ai = AI_Image::create('openai');
	 *   // Creates instance of AI_Image_Openai if class exists
	 *
	 * @example
	 *   // Create with full class name
	 *   $ai = AI_Image::create('AI_Image_Google', ['config' => 'value']);
	 *
	 * @example
	 *   // Return existing instance as-is
	 *   $existing = new AI_Image_Aws();
	 *   $ai = AI_Image::create($existing);  // Returns $existing unchanged
	 *
	 * @example
	 *   // Factory pattern with fallback and face prompt
	 *   if (!$ai = AI_Image::create('google')) {
	 *       error_log('Google adapter not found');
	 *       return;
	 *   }
	 *   $result = $ai->generate(AI_Image::promptFace('dog'), [
	 *       'images' => [$photo],
	 *       'background' => 'transparent'
	 *   ]);
	 */
	public static function create($adapter, $options = array())
	{
		if (empty($adapter)) {
			return null;
		}

		// If already an instance, return it
		if (is_object($adapter)) {
			return $adapter;
		}

		// If full class name provided and exists, instantiate
		if (is_string($adapter) && class_exists($adapter)) {
			return new $adapter($options);
		}

		// Normalize adapter string to a class suffix:
		// e.g. "openai" => "Openai" => "AI_Image_Openai"
		// e.g. "open-ai" or "open_ai" => "OpenAi" => "AI_Image_OpenAi"
		$sanitized = preg_replace('/[^a-z0-9]+/i', ' ', (string)$adapter);
		$words = array_filter(explode(' ', $sanitized));
		$suffix = implode('', array_map('ucfirst', $words));

		// Common naming convention: AI_Image_<Adapter>
		$className = "AI_Image_{$suffix}";

		if (class_exists($className)) {
			return new $className($options);
		}

		// Try alternative: prefix without underscore (legacy variations, if needed)
		$altClass = "AI_Image_" . $suffix;
		if (class_exists($altClass)) {
			return new $altClass($options);
		}

		// Not found — rely on autoloader to load file by convention if needed,
		// otherwise return null so caller can handle.
		return null;
	}
}