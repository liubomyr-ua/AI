'use strict';
/**
 * AI_Image_Openai → AI.Image.Openai
 * Adapter for OpenAI image generation (gpt-image-1.5 and family).
 * Mirrors PHP AI_Image_Openai.
 *
 * @module AI
 */
var Q        = require('Q');
var AI_Image = require('AI/Image');
var Http     = require('AI/Http');
var _post    = Http._post;
var _toBuf   = Http._toBuf;
var _isPng   = Http._isPng;
var _multipart = Http._multipart;

AI_Image.Openai = function (options) {
	this.model = Q.Config.get(['AI', 'images', 'openai', 'model'], 'gpt-image-1.5');
};
AI_Image.Openai.prototype = Object.create(AI_Image.prototype);
AI_Image.Openai.JPEG_QUALITY = 85;

/**
 * Mirrors PHP AI_Image_Openai::generate().
 * Text-only → /v1/images/generations
 * With images → /v1/images/edits  (multipart)
 * Returns Promise<{data:Buffer, format:string}>
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
		});
	}

	// Image edit (multipart)
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
	});
};

AI_Image.Openai.prototype.removeBackground = function (image, options) {
	options = Object.assign({}, options || {}, {
		images: [_toBuf(image)],
		prompt: (options && options.prompt) || 'remove background'
	});
	return this.generate(options.prompt, options);
};

module.exports = AI_Image.Openai;
