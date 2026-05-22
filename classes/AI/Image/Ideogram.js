'use strict';
/**
 * AI_Image_Ideogram → AI.Image.Ideogram
 * Adapter for Ideogram image generation and editing (v3 API).
 * Mirrors PHP AI_Image_Ideogram.
 *
 * @module AI
 */
var Q        = require('Q');
var AI_Image = require('AI/Image');
var Http     = require('AI/Http');
var _post    = Http._post;
var _get     = Http._get;
var _toBuf   = Http._toBuf;
var _isPng   = Http._isPng;
var _multipart = Http._multipart;

AI_Image.Ideogram = function (options) {};
AI_Image.Ideogram.prototype = Object.create(AI_Image.prototype);
AI_Image.Ideogram.JPEG_QUALITY = 85;

AI_Image.Ideogram.prototype.generate = function (prompt, options) {
	options  = options || {};
	var apiKey = Q.Config.get(['AI', 'ideogram', 'key'], null);
	if (!apiKey) return Promise.reject(new Error('AI.Image.Ideogram: missing API key (AI/ideogram/key)'));

	var bg  = options.background || 'none';
	var ep  = bg === 'transparent'
		? '/v1/ideogram-v3/generate-transparent'
		: '/v1/ideogram-v3/generate';
	var res = options.size || ((options.width || 1024) + 'x' + (options.height || 1024));

	var fields = {
		prompt:          prompt,
		num_images:      options.num_images       || 1,
		rendering_speed: options.rendering_speed  || 'DEFAULT',
		magic_prompt:    options.magic_prompt      || 'OFF',
		resolution:      res
	};
	if (options.style_type)      fields.style_type      = options.style_type;
	if (options.negative_prompt) fields.negative_prompt = options.negative_prompt;

	var files = [];
	(options.character_reference_images || []).forEach(function (img, i) {
		var buf = _toBuf(img);
		if (!buf) return;
		files.push({ name: 'character_reference_images[' + i + ']',
			filename: _isPng(buf) ? 'ref.png' : 'ref.jpg',
			mime: _isPng(buf) ? 'image/png' : 'image/jpeg', data: buf });
	});

	var mp = _multipart(fields, files);
	return _post('https://api.ideogram.ai' + ep, {
		'Api-Key': apiKey, 'Content-Type': mp.contentType
	}, mp.body, (options.timeout || 60) * 1000)
	.then(function (res) {
		if (res.status < 200 || res.status >= 300) {
			var err; try { err = JSON.parse(res.body); } catch(e) { err = res.body; }
			return { error: err };
		}
		var data; try { data = JSON.parse(res.body); } catch(e) { return { error: 'non-JSON' }; }
		if (!data.data || !data.data[0] || !data.data[0].url) return { error: data };
		return _get(data.data[0].url, {}, 30000).then(function (r) {
			return { data: r.binary, format: 'png' };
		});
	});
};

/**
 * edit() — mirrors PHP AI_Image_Ideogram::edit()
 */
AI_Image.Ideogram.prototype.edit = function (imageData, maskData, prompt, options) {
	options  = options || {};
	var apiKey = Q.Config.get(['AI', 'ideogram', 'key'], null);
	if (!apiKey) return Promise.reject(new Error('AI.Image.Ideogram: missing API key'));

	var imgBuf  = _toBuf(imageData);
	var maskBuf = maskData ? _toBuf(maskData) : null;
	if (!imgBuf) return Promise.reject(new Error('AI.Image.Ideogram.edit: image required'));

	var fields = {
		prompt:          prompt,
		num_images:      options.num_images       || 1,
		rendering_speed: options.rendering_speed  || 'DEFAULT',
		magic_prompt:    options.magic_prompt      || 'OFF'
	};
	if (options.style_type) fields.style_type = options.style_type;

	var files = [
		{ name: 'image', filename: _isPng(imgBuf) ? 'img.png' : 'img.jpg',
			mime: _isPng(imgBuf) ? 'image/png' : 'image/jpeg', data: imgBuf }
	];
	if (maskBuf) {
		files.push({ name: 'mask', filename: 'mask.png', mime: 'image/png', data: maskBuf });
	}

	var mp = _multipart(fields, files);
	return _post('https://api.ideogram.ai/v1/ideogram-v3/edit', {
		'Api-Key': apiKey, 'Content-Type': mp.contentType
	}, mp.body, (options.timeout || 60) * 1000)
	.then(function (res) {
		var data; try { data = JSON.parse(res.body); } catch(e) { return { error: 'non-JSON' }; }
		if (!data.data || !data.data[0] || !data.data[0].url) return { error: data };
		return _get(data.data[0].url, {}, 30000).then(function (r) {
			return { data: r.binary, format: 'png' };
		});
	});
};

module.exports = AI_Image.Ideogram;
