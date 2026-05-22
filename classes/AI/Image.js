'use strict';
/**
 * AI/Image — base class, factory, and face detection.
 *
 * This file holds:
 *   - AI_Image class (base + factory)
 *   - AI_Image.estimateFaces() — static face-detection helper
 *   - require hooks that load each adapter file (Openai/Google/Aws/
 *     Ideogram/Hotpotai/Removebg), which self-register onto AI_Image
 *     (so AI_Image.Openai etc. work without any manual wiring).
 *
 * Mirrors the PHP filesystem layout:
 *   classes/AI/Image.php             (base + factory)
 *   classes/AI/Image/<Adapter>.php   (one per provider)
 *
 * @module AI
 */
var Q  = require('Q');
var fs = require('fs');

Q.makeEventEmitter(AI_Image);

// ── AI_Image base ─────────────────────────────────────────────────────────────

function AI_Image() {}
module.exports = AI_Image;

AI_Image.prototype.setUp = function () {};

/**
 * Mirrors PHP AI_Image::create().
 * @param {string|object} adapter  'openai'|'google'|'aws'|'ideogram'|'hotpotai'|'removebg'|instance
 * @param {object} [options]
 * @returns {AI_Image|null}
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

/** Base — throw NotImplemented (mirrors PHP) */
AI_Image.prototype.generate = function (prompt, options) {
	return Promise.reject(new Error('AI.Image.generate: not implemented'));
};
AI_Image.prototype.removeBackground = function (image, options) {
	return Promise.reject(new Error('AI.Image.removeBackground: not implemented'));
};

// ── estimateFaces ─────────────────────────────────────────────────────────────

/**
 * Estimate face bounding boxes from an image file path.
 * Uses face-api.js (preferred) or @tensorflow-models/face-detection (fallback).
 *
 * If neither backend is installed, invokes callback with an empty array and
 * logs a clear error. Previously the fallback path would crash on
 * unconditional `require('@tensorflow-models/face-detection')` when that
 * package wasn't installed.
 */
AI_Image.estimateFaces = function (imagePath, callback) {
	if (!fs.existsSync(imagePath)) {
		console.warn('AI.Image.estimateFaces: file not found: ' + imagePath);
		return Q.handle(callback, null, [[]]);
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
			Q.handle(callback, null, [res]);
		}).catch(function (err) {
			console.error('AI.Image.estimateFaces (face-api.js):', err);
			Q.handle(callback, null, [[]]);
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
		return Q.handle(callback, null, [[]]);
	}

	try {
		tfCore.setBackend(tfNode ? 'tensorflow' : 'wasm').then(function () {
			tfFaceDetection.load().then(function (model) {
				fs.readFile(imagePath, function (err, data) {
					if (err) {
						console.error('AI.Image.estimateFaces: readFile failed:', err);
						return Q.handle(callback, null, [[]]);
					}
					// Decoding requires tfNode — wasm backend can't decode image bytes.
					if (!tfNode) {
						console.error('AI.Image.estimateFaces: @tensorflow/tfjs-node required '
							+ 'to decode image bytes in the tf fallback path. Returning empty result.');
						return Q.handle(callback, null, [[]]);
					}
					model.estimateFaces(tfNode.node.decodeImage(data, 3))
					.then(function (predictions) {
						var res = predictions.map(function (p) {
							return {
								topLeft:     [Math.round(p.topLeft[0]),     Math.round(p.topLeft[1])],
								bottomRight: [Math.round(p.bottomRight[0]), Math.round(p.bottomRight[1])]
							};
						});
						Q.handle(callback, null, [res]);
					}).catch(function (err) {
						console.error('AI.Image.estimateFaces (tfjs):', err);
						Q.handle(callback, null, [[]]);
					});
				});
			}).catch(function (err) {
				console.error('AI.Image.estimateFaces: model load failed:', err);
				Q.handle(callback, null, [[]]);
			});
		}).catch(function (err) {
			console.error('AI.Image.estimateFaces: setBackend failed:', err);
			Q.handle(callback, null, [[]]);
		});
	} catch (e) {
		console.error('AI.Image.estimateFaces: tfjs setup failed:', e);
		Q.handle(callback, null, [[]]);
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
