'use strict';
/**
 * AI_Image_Removebg → AI.Image.Removebg
 * Adapter for remove.bg background removal.
 * Mirrors PHP AI_Image_Removebg.
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

AI_Image.Removebg = function (options) {};
AI_Image.Removebg.prototype = Object.create(AI_Image.prototype);
AI_Image.Removebg.JPEG_QUALITY = 85;

AI_Image.Removebg.prototype.removeBackground = function (base64Image, options) {
	options  = options || {};
	var apiKey = Q.Config.get(['AI', 'removeBG', 'key'], null);
	if (!apiKey) return Promise.reject(new Error('AI.Image.Removebg: missing API key (AI/removeBG/key)'));
	var imgBuf = _toBuf(base64Image);
	if (!imgBuf) return Promise.reject(new Error('AI.Image.Removebg: invalid image'));
	var isPng = _isPng(imgBuf);
	var reqFmt = options.format && options.format !== 'auto' ? options.format : (isPng ? 'png' : 'jpg');

	var fields = {
		size:   options.size   || 'auto',
		type:   options.type   || 'auto',
		format: reqFmt
	};
	if (options.bg_color)     fields.bg_color     = options.bg_color;
	if (options.bg_image_url) fields.bg_image_url = options.bg_image_url;

	var mp = _multipart(fields, [{
		name: 'image_file',
		filename: 'image.' + (isPng ? 'png' : 'jpg'),
		mime: isPng ? 'image/png' : 'image/jpeg',
		data: imgBuf
	}]);
	return _post('https://api.remove.bg/v1.0/removebg', {
		'X-Api-Key': apiKey, 'Content-Type': mp.contentType
	}, mp.body, (options.timeout || 60) * 1000)
	.then(function (res) {
		if (res.status < 200 || res.status >= 300) {
			var err; try { err = JSON.parse(res.body); } catch(e) { err = res.body; }
			return { error: err };
		}
		return { data: res.binary, format: reqFmt };
	});
};

module.exports = AI_Image.Removebg;
