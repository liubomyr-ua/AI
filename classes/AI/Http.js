'use strict';
/**
 * AI/Http — shared HTTP, buffer, and multipart helpers used across the
 * AI plugin's adapter modules (Image, LLM, Transcription).
 *
 * Centralizing these here removes the triple-duplication that existed
 * when each adapter family inlined its own copies of _req/_get/_post/
 * _multipart. Adapter files require this module and use the exported
 * functions directly.
 *
 * Kept deliberately thin — no retries, no instrumentation, no SDK-style
 * request/response middleware. Adapters that need specialized behavior
 * (Bedrock SDK calls, streaming, etc.) handle it themselves.
 *
 * @module AI
 */
var http   = require('https');
var htt    = require('http');
var urlMod = require('url');
var crypto = require('crypto');

/**
 * Low-level request primitive. Returns a promise resolving to
 * { status, body, binary } where body is the response as a utf-8 string
 * and binary is the raw Buffer.
 *
 * @param {string} method     HTTP verb
 * @param {string} reqUrl     full URL
 * @param {object} headers
 * @param {string|Buffer|object} body  stringified if object, written verbatim if Buffer
 * @param {number} [timeoutMs]
 */
exports._req = function _req(method, reqUrl, headers, body, timeoutMs) {
	return new Promise(function (resolve, reject) {
		var parsed  = urlMod.parse(reqUrl);
		var mod     = parsed.protocol === 'https:' ? http : htt;
		var bodyBuf = body
			? (Buffer.isBuffer(body) ? body
				: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)))
			: null;
		var h = Object.assign({}, headers);
		if (bodyBuf) h['Content-Length'] = bodyBuf.length;
		var req = mod.request({
			hostname: parsed.hostname,
			port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
			path: parsed.path,
			method: method,
			headers: h
		}, function (res) {
			var chunks = [];
			res.on('data', function (c) { chunks.push(c); });
			res.on('end', function () {
				var buf = Buffer.concat(chunks);
				resolve({ status: res.statusCode, body: buf.toString(), binary: buf });
			});
		});
		req.on('error', reject);
		if (timeoutMs) req.setTimeout(timeoutMs, function () {
			req.destroy(new Error('Timeout after ' + timeoutMs + 'ms'));
		});
		if (bodyBuf) req.write(bodyBuf);
		req.end();
	});
};

exports._get  = function _get (u, h, t)     { return exports._req('GET',  u, h || {}, null, t); };
exports._post = function _post(u, h, b, t)  { return exports._req('POST', u, h || {}, b,    t); };

/**
 * Build a multipart/form-data body.
 * @param {object} fields  name→value map
 * @param {array}  files   [{ name, filename, mime, data(Buffer) }]
 * @returns {{ body: Buffer, contentType: string }}
 */
exports._multipart = function _multipart(fields, files) {
	var boundary = '----AIPart' + crypto.randomBytes(8).toString('hex');
	var CRLF     = '\r\n';
	var parts    = [];
	Object.keys(fields).forEach(function (k) {
		if (fields[k] == null) return;
		parts.push(Buffer.from(
			'--' + boundary + CRLF +
			'Content-Disposition: form-data; name="' + k + '"' + CRLF + CRLF +
			String(fields[k]) + CRLF
		));
	});
	(files || []).forEach(function (f) {
		parts.push(Buffer.concat([
			Buffer.from('--' + boundary + CRLF +
				'Content-Disposition: form-data; name="' + f.name +
				'"; filename="' + f.filename + '"' + CRLF +
				'Content-Type: ' + (f.mime || 'application/octet-stream') + CRLF + CRLF),
			f.data,
			Buffer.from(CRLF)
		]));
	});
	parts.push(Buffer.from('--' + boundary + '--' + CRLF));
	return { body: Buffer.concat(parts), contentType: 'multipart/form-data; boundary=' + boundary };
};

/** PNG magic-number check: 89 50 4E 47. */
exports._isPng = function _isPng(buf) {
	return buf && buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50;
};

/**
 * Coerce an image argument (Buffer, base64 string, or data URI) into a Buffer.
 * Returns null if input is falsy.
 */
exports._toBuf = function _toBuf(img) {
	if (!img) return null;
	if (Buffer.isBuffer(img)) return img;
	// strip data URI prefix if present
	var s = String(img);
	var comma = s.indexOf(',');
	if (comma !== -1) s = s.slice(comma + 1);
	return Buffer.from(s, 'base64');
};

/** Small sleep helper used by async adapters that implement poll(). */
exports._sleep = function _sleep(ms) {
	return new Promise(function (resolve) { setTimeout(resolve, ms); });
};
