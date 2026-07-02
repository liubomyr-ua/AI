'use strict';
/**
 * AI_Image_Google → AI.Image.Google
 * Adapter for Google Vertex AI image generation via signed proxy.
 * Supports text-to-image generation with reference images and advanced background handling.
 * Mirrors PHP AI_Image_Google.
 *
 * @module AI/Image/Google
 */
var Q        = require('Q');
var crypto   = require('crypto');
var AI_Image = require('AI/Image');
var Http     = require('AI/Http');
var _post    = Http._post;
var _toBuf   = Http._toBuf;
var _isPng   = Http._isPng;
var _multipart = Http._multipart;

/**
 * Google Vertex AI image generation adapter (via proxy).
 * Communicates with Node.js Vertex proxy server using HMAC-SHA256 request signing.
 *
 * @class AI_Image.Google
 * @extends AI_Image
 * @constructor
 * @param {object} [options] Constructor options.
 */
AI_Image.Google = function (options) {};
AI_Image.Google.prototype = Object.create(AI_Image.prototype);
AI_Image.Google.JPEG_QUALITY = 85;

/**
 * Generates an image from a text prompt using Google Vertex AI via proxy.
 * Supports text-to-image generation and image-guided generation with reference images.
 * Includes advanced background handling: keep original, transparent, or gradient.
 *
 * @method generate
 * @param {string} prompt Description of the image to generate.
 * @param {object} [options] Generation options:
 *   - @param {string} [options.format="png"] Output format: "png", "jpg", "webp", "gif".
 *   - @param {integer} [options.width=1024] Image width in pixels (max 4096).
 *   - @param {integer} [options.height=1024] Image height in pixels (max 4096).
 *   - @param {string} [options.size] Alternative: "WIDTHxHEIGHT" (overrides width/height).
 *   - @param {string} [options.background="none"] Background mode: "none", "transparent", "gradient".
 *       - "none": Keep original background.
 *       - "transparent": Remove background, output RGBA PNG.
 *       - "gradient": Composite onto teal-to-blue gradient.
 *   - @param {integer} [options.feather=20] Alpha feathering for transparency edges (pixels, 0–100).
 *       Only applies when background="transparent". Ignored for "none" or "gradient".
 *   - @param {string} [options.bgColor] Custom background hint color (hex format, e.g., "#f2f2f2").
 *       Used to guide model for cleaner subject isolation when background="transparent".
 *   - @param {array} [options.images] Reference images (binary) for guided generation.
 *       Supports up to 5 images. Reference in prompt as "photo 1", "photo 2", etc.
 *   - @param {integer} [options.timeout=60] Request timeout in seconds.
 *
 * @return {Promise} Resolves to:
 *   - Success: {data: Buffer (binary image), format: string}
 *   - Error: {error: string or decoded JSON}
 *
 * @example
 *   var ai = AI_Image.create('google');
 *   ai.generate('A serene Japanese garden with koi pond', {
 *       format: 'png',
 *       width: 1024,
 *       height: 1024
 *   }).then(function(res) {
 *       if (res.data) {
 *           fs.writeFileSync('garden.png', res.data);
 *       }
 *   });
 *
 * @example
 *   // Generate with transparent background
 *   ai.generate('Professional headshot portrait', {
 *       background: 'transparent',
 *       format: 'png',
 *       feather: 15,
 *       bgColor: '#ffffff'
<<<<<<< HEAD
 *   }).then(function(res) { /\* ... *\/ });
=======
 *   }).then(function(res) { ... });
>>>>>>> 644a2e484539b8771cc518c96f6859dd01092fa1
 *
 * @example
 *   // Image-guided generation using reference image
 *   var styleRef = fs.readFileSync('style_reference.jpg');
 *   ai.generate('Paint this scene in the style of photo 1 with sunset', {
 *       images: [styleRef],
 *       width: 1536,
 *       height: 1024,
 *       background: 'transparent'
<<<<<<< HEAD
 *   }).then(function(res) { /\* ... *\/ });
=======
 *   }).then(function(res) { ... });
>>>>>>> 644a2e484539b8771cc518c96f6859dd01092fa1
 *
 * @example
 *   // Composite over gradient background
 *   ai.generate('Product lifestyle shot', {
 *       background: 'gradient',
 *       format: 'png',
 *       width: 1200,
 *       height: 630
<<<<<<< HEAD
 *   }).then(function(res) { /\* ... *\/ });
=======
 *   }).then(function(res) { ... });
>>>>>>> 644a2e484539b8771cc518c96f6859dd01092fa1
 */
AI_Image.Google.prototype.generate = function (prompt, options) {
	options  = options || {};
	var proxyUrl = (Q.Config.get(['AI', 'google', 'url'], '') + '').replace(/\/$/, '');
	var clientId = Q.Config.get(['AI', 'google', 'clientId'], null);
	var secret   = Q.Config.get(['AI', 'google', 'secret'],   null);
	if (!proxyUrl || !clientId || !secret) {
		return Promise.reject(new Error('AI.Image.Google: missing config (AI/google/url|clientId|secret)'));
	}
	var ts  = Math.floor(Date.now() / 1000);
	var sig = crypto.createHmac('sha256', secret).update(clientId + ts).digest('hex');

	var fields = {
		prompt:     prompt,
		format:     options.format     || 'png',
		width:      options.width      || 1024,
		height:     options.height     || 1024,
		background: options.background || 'none',
		feather:    options.background === 'transparent' ? (options.feather || 0) : 0
	};
	if (options.background === 'transparent' && options.bgColor) {
		fields.bgColor = options.bgColor;
	}

	var files = [];
	(options.images || []).slice(0, 5).forEach(function (img, i) {
		var buf = _toBuf(img);
		if (!buf) return;
		files.push({
			name: 'photo' + (i + 1),
			filename: _isPng(buf) ? 'img.png' : 'img.jpg',
			mime: _isPng(buf) ? 'image/png' : 'image/jpeg',
			data: buf
		});
	});

	var mp = _multipart(fields, files);
	return _post(proxyUrl + '/generate', {
		'X-Client-ID': clientId, 'X-Timestamp': String(ts), 'X-Signature': sig,
		'Content-Type': mp.contentType
	}, mp.body, (options.timeout || 60) * 1000)
	.then(function (res) {
		if (res.status < 200 || res.status >= 300) {
			var err; try { err = JSON.parse(res.body); } catch(e) { err = res.body; }
			return { error: err };
		}
		return { data: res.binary, format: fields.format };
	}).catch(function (err) {
		return { error: err.message || err };
	});
};

/**
 * Removes the background from an image using Google Vertex AI via proxy.
 * Outputs a PNG with transparent background and optimized alpha channel.
 * The proxy server handles edge feathering and alpha channel optimization.
 *
 * @method removeBackground
 * @param {Buffer|string} image Binary image data or file path.
 * @param {object} [options] Processing options (see generate() for common options).
 *   Additional notable options:
 *   - @param {string} [options.prompt="remove background"] Custom prompt for subject isolation.
 *   - @param {string} [options.format="png"] Output format (png recommended).
 *   - @param {integer} [options.feather=20] Alpha feathering for smooth edges (pixels).
 *       Higher values = smoother but less precise. Default: 20.
 *   - @param {string} [options.bgColor="#f2f2f2"] Hint color for background detection.
 *       Example: "#ffffff" (white).
 *
 * @return {Promise} Resolves to:
 *   - Success: {data: Buffer (PNG with transparency), format: 'png'}
 *   - Error: {error: mixed}
 *
 * @example
 *   var imageBinary = fs.readFileSync('portrait.jpg');
 *   ai.removeBackground(imageBinary, {
 *       format: 'png',
 *       feather: 25,
 *       bgColor: '#ffffff'
 *   }).then(function(res) {
 *       if (res.data) {
 *           fs.writeFileSync('portrait_transparent.png', res.data);
 *       }
 *   });
 */
AI_Image.Google.prototype.removeBackground = function (image, options) {
	return this.generate(
		(options && options.prompt) || 'remove background',
		Object.assign({}, options || {}, {
			images: [_toBuf(image)],
			background: 'transparent'
		})
	);
};

module.exports = AI_Image.Google;