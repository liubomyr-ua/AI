'use strict';
/**
 * AI_LLM_Google → AI.LLM.Google
 * Gemini adapter via Google Generative Language API.
 * Mirrors PHP AI_LLM_Google.
 *
 * @module AI
 */
var Q      = require('Q');
var AI_LLM = require('AI/LLM');
var Http   = require('AI/Http');
var _post  = Http._post;

AI_LLM.Google = function(options) {
	this.apiKey = Q.Config.get(['AI', 'google', 'api_key'], null);
	this.model  = Q.Config.get(['AI', 'llm', 'models', 'google'],
		Q.Config.get(['AI', 'google', 'llm_model'], 'models/gemini-1.5-flash'));
};
AI_LLM.Google.prototype = Object.create(AI_LLM.prototype);

AI_LLM.Google.prototype.executeModel = function(instructions, inputs, options) {
	options = options || {};
	var model      = options.model      || this.model;
	var apiKey     = options.apiKey     || this.apiKey;
	if (!apiKey) return Promise.reject(new Error('AI.LLM.Google: missing API key (AI/google/api_key)'));
	var temperature = options.temperature != null ? options.temperature : 0.5;
	var maxTokens   = options.max_tokens  || 3000;
	var rf = options.response_format, js = options.json_schema;

	var system = '';
	if (rf === 'json_schema' && js) {
		system += 'You are a strict JSON generator.\nOutput MUST conform exactly to this JSON Schema:\n\n' +
			JSON.stringify(js, null, 2) + '\n\nRules:\n- Output JSON only\n- No prose, comments, or markdown\n- No omit required fields\n- Use null when uncertain\n\n';
	} else if (rf === 'json') {
		system += 'You are a strict JSON generator.\nOutput MUST be valid JSON.\nDo not include prose, comments, or markdown.\n\n';
	}

	var parts = [];
	if (instructions) parts.push({ text: system + instructions });
	else if (system)  parts.push({ text: system });

	if (inputs && inputs.text) parts.push({ text: inputs.text });
	if (inputs && Array.isArray(inputs.images)) {
		inputs.images.forEach(function(img) {
			var b64 = Buffer.isBuffer(img) ? img.toString('base64') : img;
			var mime = b64.startsWith('iVBORw0KGgo') ? 'image/png' : 'image/jpeg';
			parts.push({ inline_data: { mime_type: mime, data: b64 } });
		});
	}

	var endpoint = 'https://generativelanguage.googleapis.com/v1beta/' +
		model + ':generateContent?key=' + encodeURIComponent(apiKey);

	var payload = {
		contents: [{ role: 'user', parts: parts }],
		generationConfig: { temperature: temperature, maxOutputTokens: maxTokens }
	};

	return _post(endpoint, { 'Content-Type': 'application/json' }, payload,
		(options.timeout || 300) * 1000
	).then(function(res) {
		if (res.status < 200 || res.status >= 300) {
			throw new Error('AI.LLM.Google: HTTP ' + res.status + ': ' + res.body.slice(0, 400));
		}
		var data; try { data = JSON.parse(res.body); } catch(e) { throw new Error('AI.LLM.Google: non-JSON response'); }
		var respParts = data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
		if (!respParts) return '';
		return respParts.filter(function(p) { return typeof p.text === 'string'; })
			.map(function(p) { return p.text; }).join('').trim();
	});
};

module.exports = AI_LLM.Google;
