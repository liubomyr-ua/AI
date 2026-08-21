'use strict';
/**
 * AI/Image — base class, factory, face detection, and prompt utilities.
 *
 * This module provides:
 *   - AI_Image class (base + factory, mirrors PHP AI_Image)
 *   - AI_Image.estimateFaces() — static face-detection helper
 *   - AI_Image.promptFace() — static smart face prompt generator
 *   - Auto-loading hooks for each adapter (Openai, Google, Aws, Ideogram, Hotpotai, Removebg)
 *     which self-register onto AI_Image (so AI_Image.Openai, etc. work without manual wiring).
 *
 * Mirrors the PHP filesystem layout:
 *   classes/AI/Image.php             (base + factory)
 *   classes/AI/Image/<Adapter>.php   (one per provider)
 *
 * @module AI/Image
 */
var Q  = require('Q');
var fs = require('fs');

Q.makeEventEmitter(AI_Image);

// ── AI_Image base ─────────────────────────────────────────────────────────────

/**
 * Base class for image generation and processing.
 * Subclasses implement generate() and removeBackground() for specific providers.
 * @class AI_Image
 * @constructor
 */
function AI_Image() {}
module.exports = AI_Image;

AI_Image.prototype.setUp = function () {};

/**
 * Factory method to create or resolve an AI image adapter instance.
 * Mirrors PHP AI_Image::create().
 *
 * @static
 * @method create
 * @param {string|object} adapter Adapter name ("openai", "google", "aws", etc.),
 *   full class reference, or existing instance.
 * @param {object} [options] Optional constructor parameters.
 * @return {AI_Image|null} Instance of adapter, or null if not found.
 *
 * @example
 *   var ai = AI_Image.create('google');
 *   ai.generate('prompt', {background: 'transparent'}).then(function(res) {
 *       // res = {data: Buffer, format: 'png'} or {error: mixed}
 *   });
 */
AI_Image.create = function (adapter, options) {
	if (!adapter) return null;
	if (typeof adapter === 'object') return adapter;
	var s = adapter.replace(/[^a-z0-9]+/gi, ' ').trim();
	var suffix = s.replace(/\s+(.)/g, function (_, c) { return c.toUpperCase(); });
	suffix = suffix.charAt(0).toUpperCase() + suffix.slice(1);
	var cls = AI_Image[suffix];
	if (cls) return new cls(options);
	return null;
};

/**
 * Base implementation of generate — throws NotImplemented (mirrors PHP).
 * Subclasses must override.
 *
 * @method generate
 * @param {string} $prompt Image description.
 * @param {object} [options] Generation options (adapter-specific).
 * @return {Promise} Resolves to {data: Buffer, format: string} or {error: mixed}.
 * @throws {Error} "AI.Image.generate: not implemented"
 * @protected
 */
AI_Image.prototype.generate = function (prompt, options) {
	return Promise.reject(new Error('AI.Image.generate: not implemented'));
};

/**
 * Base implementation of removeBackground — throws NotImplemented (mirrors PHP).
 * Subclasses must override.
 *
 * @method removeBackground
 * @param {Buffer|string} image Binary image data or file path.
 * @param {object} [options] Processing options (adapter-specific).
 * @return {Promise} Resolves to {data: Buffer, format: string} or {error: mixed}.
 * @throws {Error} "AI.Image.removeBackground: not implemented"
 * @protected
 */
AI_Image.prototype.removeBackground = function (image, options) {
	return Promise.reject(new Error('AI.Image.removeBackground: not implemented'));
};

// ── promptFace ─────────────────────────────────────────────────────────────────

/**
 * Curated list of 100 recognizable animals for fallback face generation.
 * Used when input is not a face or NSFW content is detected.
 * Covers diverse categories: mammals, birds, reptiles, aquatic, insects, mythical.
 * @static
 * @private
 * @type {array}
 */
AI_Image.ANIMALS = [
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
];

/**
 * Generates a smart prompt for face image generation and background removal.
 * Intelligently handles three cases:
 * 1. Complete visible face → center and remove background, preserve face
 * 2. Partial/obscured face → generate full face close to original, remove background
 * 3. Non-face input (NSFW, objects, animals) → generate cute animal face instead
 *
 * Returns a unified prompt that works across all providers (OpenAI, AWS, Google).
 * Designed for use with generate(prompt, {images: [photo], background: 'transparent'}).
 *
 * @static
 * @method promptFace
 * @param {string} [defaultAnimal=null] Default animal name for non-face fallback.
 *   When input is not a face, generates a cute face of this animal instead.
 *   If null or invalid, randomly selects from 100 curated recognizable animals.
 *   Examples: "cat", "dog", "fox", "polar bear", "penguin", "unicorn".
 *   Invalid names are silently ignored; animal selection proceeds randomly.
 *
 * @return {string} Multi-case prompt optimized for face detection, generation, and background removal.
 *   Prompt covers all three scenarios in a single unified instruction for maximum provider compatibility.
 *   Output guarantees: face in center, background removed, high quality.
 *
 * @example
 *   // Automatic animal selection (random from 100 curated list)
 *   var prompt = AI_Image.promptFace();
 *   ai.generate(prompt, {images: [photoBuffer], background: 'transparent'})
 *     .then(function(res) { ... });
 *
 * @example
 *   // Specific animal fallback for consistent branding
 *   var prompt = AI_Image.promptFace('cat');
 *   ai.generate(prompt, {
 *       images: [fs.readFileSync('user.jpg')],
 *       format: 'png',
 *       background: 'transparent'
 *   }).then(function(res) { ... });
 *
 * @example
 *   // Use with Google adapter for best results (native transparency support)
 *   var ai = AI_Image.create('google');
 *   ai.generate(AI_Image.promptFace('fox'), {
 *       images: [userPhotoBuffer],
 *       background: 'transparent',
 *       feather: 20
 *   }).then(function(res) { {data: Buffer, format: 'png'} });
 *
 * @example
 *   // Fallback handling: NSFW or non-face input → cute animal instead
 *   // Input: NSFW image        → Output: cute cat face (if defaultAnimal='cat')
 *   // Input: random object     → Output: cute dog face (if defaultAnimal='dog')
 *   // Input: partial/poor face → Output: full clear face similar to input
 */
AI_Image.promptFace = function (defaultAnimal) {
	var animal = defaultAnimal;
	if (!animal || AI_Image.ANIMALS.indexOf(animal.toLowerCase()) === -1) {
		animal = AI_Image.ANIMALS[Math.floor(Math.random() * AI_Image.ANIMALS.length)];
	} else {
		animal = animal.toLowerCase();
	}

	return "If the person's face is completely visible, center it in the photo and remove background, "
		+ "without changing the face. "
		+ "If the face is not completely visible, then generate a photo of their face in the center, "
		+ "as close as possible to what they look like, with background removed. "
		+ "If the input image is not a face at all, then generate the detailed face of a cute " + animal + ", "
		+ "in the middle, with background removed. "
		+ "Either way, the output is the face in the center, with no background.";
};

// ── estimateFaces ─────────────────────────────────────────────────────────────

/**
 * Estimate face bounding boxes from an image file path.
 * Uses face-api.js (preferred) or @tensorflow-models/face-detection (fallback).
 *
 * If neither backend is installed, invokes callback with an empty array and
 * logs a clear error. Previously the fallback path would crash on
 * unconditional require('@tensorflow-models/face-detection') when that
 * package wasn't installed.
 *
 * @static
 * @method estimateFaces
 * @param {string} imagePath File path to image.
 * @param {function} callback Callback function(err, faces) where faces is array of
 *   {topLeft: [x, y], bottomRight: [x, y]} objects, or [] if no faces detected or error.
 *
 * @example
 *   AI_Image.estimateFaces('/path/to/photo.jpg', function(err, faces) {
 *       if (faces.length) {
 *           console.log('Found ' + faces.length + ' face(s)');
 *           faces.forEach(function(f) {
 *               console.log('  topLeft:', f.topLeft, 'bottomRight:', f.bottomRight);
 *           });
 *       }
 *   });
 */
AI_Image.estimateFaces = function (imagePath, callback) {
	if (!fs.existsSync(imagePath)) {
		console.warn('AI.Image.estimateFaces: file not found: ' + imagePath);
		return Q.handle(callback, null, [[], null]);
	}

	// Probe optional backends. These are heavy, fragile, and commonly absent.
	var tfNode = null;
	try { tfNode = require('@tensorflow/tfjs-node'); } catch (e) {}

	var faceAPI = null, canvas = null;
	try {
		faceAPI = require('face-api.js');
		canvas = require('canvas');
	} catch (e) {
		faceAPI = null; // need both together
	}

	// Preferred path: face-api.js
	if (faceAPI && canvas) {
		var Canvas = canvas.Canvas, Image = canvas.Image, ImageData = canvas.ImageData;
		faceAPI.env.monkeyPatch({ Canvas: Canvas, Image: Image, ImageData: ImageData });
		faceAPI.nets.ssdMobilenetv1.loadFromDisk('../../web/Q/plugins/Streams/js/face-api/weights')
		.then(function () {
			return canvas.loadImage(imagePath);
		}).then(function (image) {
			return faceAPI.detectAllFaces(image, new faceAPI.SsdMobilenetv1Options({ minConfidence: 0.2 }));
		}).then(function (predictions) {
			var res = predictions.map(function (p) {
				return {
					topLeft:     [Math.round(p._box._x), Math.round(p._box._y)],
					bottomRight: [Math.round(p._box._x + p._box._width), Math.round(p._box._y + p._box._height)]
				};
			});
			Q.handle(callback, null, [res, null]);
		}).catch(function (err) {
			console.error('AI.Image.estimateFaces (face-api.js):', err);
			Q.handle(callback, null, [[], err]);
		});
		return;
	}

	// Fallback path: @tensorflow-models/face-detection — requires three
	// separate packages. Probe them before using, so a missing install
	// fails with a clear message instead of crashing on require().
	var tfFaceDetection = null, tfCore = null;
	try {
		tfFaceDetection = require('@tensorflow-models/face-detection');
		tfCore          = require('@tensorflow/tfjs-core');
		require('@tensorflow/tfjs-converter');
	} catch (e) {
		console.error('AI.Image.estimateFaces: no face-detection backend installed. '
			+ 'Install face-api.js + canvas, OR @tensorflow-models/face-detection + '
			+ '@tensorflow/tfjs-core + @tensorflow/tfjs-converter '
			+ '(optionally + @tensorflow/tfjs-node). Returning empty result.');
		return Q.handle(callback, null, [[], e]);
	}

	try {
		tfCore.setBackend(tfNode ? 'tensorflow' : 'wasm').then(function () {
			tfFaceDetection.load().then(function (model) {
				fs.readFile(imagePath, function (err, data) {
					if (err) {
						console.error('AI.Image.estimateFaces: readFile failed:', err);
						return Q.handle(callback, null, [[], err]);
					}
					// Decoding requires tfNode — wasm backend can't decode image bytes.
					if (!tfNode) {
						console.error('AI.Image.estimateFaces: @tensorflow/tfjs-node required '
							+ 'to decode image bytes in the tf fallback path. Returning empty result.');
						return Q.handle(callback, null, [[], new Error('tfjs-node required')]);
					}
					model.estimateFaces(tfNode.node.decodeImage(data, 3))
					.then(function (predictions) {
						var res = predictions.map(function (p) {
							return {
								topLeft:     [Math.round(p.topLeft[0]),     Math.round(p.topLeft[1])],
								bottomRight: [Math.round(p.bottomRight[0]), Math.round(p.bottomRight[1])]
							};
						});
						Q.handle(callback, null, [res, null]);
					}).catch(function (err) {
						console.error('AI.Image.estimateFaces (tfjs):', err);
						Q.handle(callback, null, [[], err]);
					});
				});
			}).catch(function (err) {
				console.error('AI.Image.estimateFaces: model load failed:', err);
				Q.handle(callback, null, [[], err]);
			});
		}).catch(function (err) {
			console.error('AI.Image.estimateFaces: setBackend failed:', err);
			Q.handle(callback, null, [[], err]);
		});
	} catch (e) {
		console.error('AI.Image.estimateFaces: tfjs setup failed:', e);
		Q.handle(callback, null, [[], e]);
	}
};

// ── Auto-register all adapter files ───────────────────────────────────────────
// Each adapter self-attaches to AI_Image (e.g. AI_Image.Openai = function() {})
// when required. Loading them here means AI_Image.create('openai') works
// without the caller needing to pre-load the adapter module explicitly.

require('AI/Image/Openai');
require('AI/Image/Google');
require('AI/Image/Aws');
require('AI/Image/Ideogram');
require('AI/Image/Hotpotai');
require('AI/Image/Removebg');