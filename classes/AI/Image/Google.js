'use strict';
/**
 * AI_Image_Google → AI.Image.Google
 * Adapter for Google's image generation (via signed proxy).
 * Mirrors PHP AI_Image_Google.
 *
 * @module AI
 */
var Q        = require('Q');
var crypto   = require('crypto');
var AI_Image = require('AI/Image');
var Http     = require('AI/Http');
var _post    = Http._post;
var _toBuf   = Http._toBuf;
var _isPng   = Http._isPng;
var _multipart = Http._multipart;

AI_Image.Google = function (options) {};
AI_Image.Google.prototype = Object.create(AI_Image.prototype);
AI_Image.Google.JPEG_QUALITY = 85;

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
	});
};

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
