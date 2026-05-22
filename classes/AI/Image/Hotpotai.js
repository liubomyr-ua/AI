'use strict';
/**
 * AI_Image_Hotpotai → AI.Image.Hotpotai
 * Adapter for Hotpot AI (remove-background + make-art endpoints).
 * Mirrors PHP AI_Image_Hotpotai.
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

AI_Image.Hotpotai = function (options) {};
AI_Image.Hotpotai.prototype = Object.create(AI_Image.prototype);
AI_Image.Hotpotai.JPEG_QUALITY = 85;

AI_Image.Hotpotai.prototype.removeBackground = function (image, options) {
	options  = options || {};
	var apiKey = Q.Config.get(['AI', 'hotpot', 'key'], null);
	if (!apiKey) return Promise.reject(new Error('AI.Image.Hotpotai: missing API key (AI/hotpot/key)'));
	var imgBuf = _toBuf(image);
	if (!imgBuf) return Promise.reject(new Error('AI.Image.Hotpotai: invalid image'));
	var isPng  = _isPng(imgBuf);
	var fmt    = isPng ? 'png' : 'jpg';

	var fields = {};
	['backgroundColor', 'compressionFactor', 'returnAlpha'].forEach(function (f) {
		if (options[f] != null) fields[f] = String(options[f]);
	});
	var mp = _multipart(fields, [{
		name: 'image', filename: 'input.' + fmt,
		mime: isPng ? 'image/png' : 'image/jpeg', data: imgBuf
	}]);
	return _post('https://api.hotpot.ai/remove-background', {
		'Authorization': apiKey, 'Content-Type': mp.contentType
	}, mp.body, (options.timeout || 60) * 1000)
	.then(function (res) {
		if (!res.binary || !res.binary.length) return { error: 'Empty response' };
		return { data: res.binary, format: fmt };
	});
};

AI_Image.Hotpotai.prototype.generate = function (prompt, options) {
	options  = options || {};
	var apiKey = Q.Config.get(['AI', 'hotpot', 'key'], null);
	if (!apiKey) return Promise.reject(new Error('AI.Image.Hotpotai: missing API key'));
	var fields = { inputText: prompt, styleId: options.styleId || 'default' };
	if (options.negativePrompt) fields.negativePrompt = options.negativePrompt;
	var mp = _multipart(fields, []);
	return _post('https://api.hotpot.ai/make-art', {
		'Authorization': apiKey, 'Content-Type': mp.contentType
	}, mp.body, (options.timeout || 60) * 1000)
	.then(function (res) {
		if (!res.binary) return { error: 'Empty response' };
		return { data: res.binary, format: 'png' };
	});
};

module.exports = AI_Image.Hotpotai;
