'use strict';
/**
 * AI_Image_Openai → AI.Image.Openai
 * Adapter for OpenAI image generation (gpt-image-1.5, DALL-E 3, DALL-E 2).
 * Supports text-only generation and image-based edits with reference images.
 * Mirrors PHP AI_Image_Openai.
 *
 * @module AI/Image/Openai
 */
var Q        = require('Q');
var AI_Image = require('AI/Image');
var Http     = require('AI/Http');
var _post    = Http._post;
var _toBuf   = Http._toBuf;
var _isPng   = Http._isPng;
var _multipart = Http._multipart;

/**
 * OpenAI image generation adapter (DALL-E).
 * Communicates with OpenAI Images API (generations or edits endpoints).
 *
 * @class AI_Image.Openai
 * @extends AI_Image
 * @constructor
 * @param {object} [options] Constructor options.
 */
AI_Image.Openai = function (options) {
	this.model = Q.Config.get(['AI', 'images', 'openai', 'model'], 'gpt-image-1.5');
};
AI_Image.Openai.prototype = Object.create(AI_Image.prototype);
AI_Image.Openai.JPEG_QUALITY = 85;

/**
 * Generates an image from a text prompt using OpenAI Images API.
 * Supports text-only generation (generates endpoint) or image-based editing (edits endpoint).
 *
 * @method generate
 * @param {string} prompt Description of the image to generate or desired edits.
 * @param {object} [options] Generation options:
 *   - @param {string} [options.model="gpt-image-1.5"] Model ID: "dall-e-3", "dall-e-2", "gpt-image-1.5".
 *   - @param {string} [options.format="png"] Output format: "png", "jpg", "jpeg", "webp".
 *   - @param {string} [options.size="1024x1024"] Dimensions as "WIDTHxHEIGHT" or via width/height.
 *   - @param {integer} [options.width=1024] Image width (overrides size parameter).
 *   - @param {integer} [options.height=1024] Image height (overrides size parameter).
 *   - @param {string} [options.quality="auto"] Quality: "standard" (→ auto), "hd" (→ high). DALL-E 3 only.
 *   - @param {array} [options.images] Reference images (binary) for edit mode. Triggers /images/edits endpoint.
 *   - @param {integer} [options.timeout=60] Request timeout in seconds.
 *
 * @return {Promise} Resolves to:
 *   - Success: {data: Buffer (binary image), format: string}
 *   - Error: {error: string or decoded JSON}
 *
 * @example
 *   var ai = AI_Image.create('openai');
 *   ai.generate('A serene mountain landscape at sunset', {
 *       model: 'dall-e-3',
 *       format: 'png',
 *       size: '1024x1024',
 *       quality: 'hd'
 *   }).then(function(res) {
 *       if (res.data) {
 *           fs.writeFileSync('output.png', res.data);
 *       } else {
 *           console.error('Error:', res.error);
 *       }
 *   });
 *
 * @example
 *   // Image editing with reference
 *   var baseImage = fs.readFileSync('original.jpg');
 *   ai.generate('Change the sky to vibrant purple', {
 *       images: [baseImage],
 *       model: 'dall-e-2',
 *       format: 'png'
 *   }).then(function(res) { ... });
 *
 * @example
 *   // Face generation with smart prompt
 *   ai.generate(AI_Image.promptFace('cat'), {
 *       images: [userPhotoBuffer],
 *       format: 'png'
 *   }).then(function(res) { ... });
 */
AI_Image.Openai.prototype.generate = function (prompt, options) {
	options   = options || {};
	var apiKey = Q.Config.get(['AI', 'openAI', 'key'], null);
	if (!apiKey) return Promise.reject(new Error('AI.Image.Openai: missing API key (AI/openAI/key)'));
	var model   = options.model   || this.model;
	var format  = (options.format || 'png').toLowerCase();
	var timeout = (options.timeout || 60) * 1000;
	var images  = options.images;
	var useEdit = Array.isArray(images) && images.length;

	if (!useEdit) {
		// ===== TEXT-ONLY GENERATION (POST /v1/images/generations) =====
		var size = options.size || ((options.width || 1024) + 'x' + (options.height || 1024));
		var qualityMap = { standard: 'auto', hd: 'high' };
		var quality = qualityMap[options.quality] || options.quality || 'auto';
		return _post('https://api.openai.com/v1/images/generations', {
			'Authorization': 'Bearer ' + apiKey,
			'Content-Type': 'application/json'
		}, JSON.stringify({ model: model, prompt: prompt, size: size, quality: quality, n: 1 }), timeout)
		.then(function (res) {
			var data; try { data = JSON.parse(res.body); } catch(e) { return { error: 'non-JSON response' }; }
			if (!data.data || !data.data[0] || !data.data[0].b64_json) return { error: data };
			var buf = Buffer.from(data.data[0].b64_json, 'base64');
			return { data: buf, format: format };
		}).catch(function (err) {
			return { error: err.message || err };
		});
	}

	// ===== IMAGE-BASED EDITING (POST /v1/images/edits, multipart) =====
	var imgBuf  = _toBuf(images[0]);
	if (!imgBuf) return Promise.reject(new Error('AI.Image.Openai: invalid image input'));
	var imgMime = _isPng(imgBuf) ? 'image/png' : 'image/jpeg';
	var mp      = _multipart(
		{ model: model, prompt: prompt, n: '1' },
		[{ name: 'image', filename: _isPng(imgBuf) ? 'image.png' : 'image.jpg', mime: imgMime, data: imgBuf }]
	);
	return _post('https://api.openai.com/v1/images/edits', {
		'Authorization': 'Bearer ' + apiKey, 'Content-Type': mp.contentType
	}, mp.body, timeout)
	.then(function (res) {
		var data; try { data = JSON.parse(res.body); } catch(e) { return { error: 'non-JSON' }; }
		if (!data.data || !data.data[0] || !data.data[0].b64_json) return { error: data };
		return { data: Buffer.from(data.data[0].b64_json, 'base64'), format: format };
	}).catch(function (err) {
		return { error: err.message || err };
	});
};

/**
 * Removes the background from an image using OpenAI image edits API.
 * Generates a prompt internally to isolate the subject on a transparent background.
 *
 * @method removeBackground
 * @param {Buffer|string} image Binary image data or file path.
 * @param {object} [options] Processing options (see generate() for common options).
 *   - @param {string} [options.prompt="remove background"] Custom edit prompt.
 *   - @param {string} [options.format="png"] Output format (png recommended).
 *
 * @return {Promise} Resolves to {data: Buffer (PNG), format: 'png'} or {error: mixed}.
 *
 * @example
 *   var imageBinary = fs.readFileSync('portrait.jpg');
 *   ai.removeBackground(imageBinary, {format: 'png'})
 *     .then(function(res) {
 *         if (res.data) {
 *             fs.writeFileSync('portrait_transparent.png', res.data);
 *         }
 *     });
 */
AI_Image.Openai.prototype.removeBackground = function (image, options) {
	options = Object.assign({}, options || {}, {
		images: [_toBuf(image)],
		prompt: (options && options.prompt) || 'remove background'
	});
	return this.generate(options.prompt, options);
};

module.exports = AI_Image.Openai;