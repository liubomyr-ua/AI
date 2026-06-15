'use strict';
/**
 * AI_LLM_Openai -> AI.LLM.Openai
 * OpenAI Responses API adapter.
 *
 * Web search: uses the built-in web_search tool (formerly web_search_preview).
 * Activated via options.webSearch = true | { maxUses, contextSize, allowedDomains, userLocation }.
 *
 * Response normalisation:
 *   The Responses API output array can contain web_search_call items and
 *   message items. _extractText() concatenates all output_text blocks and
 *   _extractCitations() collects url_citation annotations.
 *
 * @module AI
 */
var Q      = require('Q');
var AI_LLM = require('AI/LLM');
var Http   = require('AI/Http');
var _post  = Http._post;

AI_LLM.Openai = function (options) {
	options = options || {};
	this.model = options.model
		|| Q.Config.get(['AI', 'llm', 'models', 'openai'], 'gpt-4.1-mini');
	this.apiKey = options.apiKey
		|| Q.Config.get(['AI', 'openAI', 'key'], null);
};
AI_LLM.Openai.prototype = Object.create(AI_LLM.prototype);
AI_LLM.Openai.prototype.constructor = AI_LLM.Openai;

AI_LLM.Openai.prototype.supportsWebSearch = function () { return true; };

/**
 * Build the web_search tool entry for the Responses API payload.
 * Uses "web_search" (current) with web_search_preview as silent fallback
 * for models that don't yet support the newer name.
 * @private
 */
AI_LLM.Openai.prototype._buildWebSearchTool = function (ws) {
	var tool = { type: 'web_search' };

	// search_context_size: low | medium | high
	if (ws.contextSize) tool.search_context_size = ws.contextSize;

	// Domain filtering
	if (ws.allowedDomains && ws.allowedDomains.length) {
		tool.filters = { allowed_domains: ws.allowedDomains };
	}

	// Approximate user location for geo-relevant results
	if (ws.userLocation) {
		tool.user_location = Object.assign({ type: 'approximate' }, ws.userLocation);
	}

	return tool;
};

AI_LLM.Openai.prototype.executeModel = function (instructions, inputs, options) {
	var self = this;
	options  = options || {};

	var model       = options.model       || this.model;
	var apiKey      = options.apiKey      || this.apiKey;
	if (!apiKey) return Promise.reject(new Error('AI.LLM.Openai: missing API key (AI/openAI/key)'));

	var maxTokens   = options.max_tokens  || 3000;
	var temperature = options.temperature != null ? options.temperature : 0.5;
	var messages    = options.messages    || [];

	// ── Build input ───────────────────────────────────────────────────────────
	var content = [];
	if (inputs && inputs.text) {
		content.push({ type: 'input_text', text: inputs.text });
	}
	if (inputs && Array.isArray(inputs.images)) {
		inputs.images.forEach(function (img) {
			var b64  = Buffer.isBuffer(img) ? img.toString('base64') : img;
			var mime = b64.startsWith('iVBORw0KGgo') ? 'image/png' : 'image/jpeg';
			content.push({ type: 'input_image', image_url: 'data:' + mime + ';base64,' + b64 });
		});
	}

	var input;
	if (messages.length) {
		input = messages.map(function (m) {
			var c = typeof m.content === 'string'
				? [{ type: 'input_text', text: m.content }] : m.content;
			return { role: m.role || 'user', content: c };
		});
	} else {
		input = [{ role: 'user', content: content }];
	}

	// ── Build payload ─────────────────────────────────────────────────────────
	var payload = {
		model:             model,
		input:             input,
		max_output_tokens: maxTokens,
		temperature:       temperature
	};
	if (instructions) payload.instructions = instructions;

	// ── Structured output — Responses API ──────────────────────────────────────
	// NOTE: the Responses API puts structured output under text.format, flattened
	// (no inner "json_schema" wrapper). The Chat Completions "response_format" key
	// is deprecated on this endpoint. strict mode requires additionalProperties
	// false and every property in "required", which AI_LLM.makeStrict() enforces.
	var rf = options.response_format, js = options.json_schema;
	if (rf === 'json_schema' && js) {
		payload.text = {
			format: {
				type:   'json_schema',
				name:   options.schema_name || 'result',
				strict: true,
				schema: AI_LLM.makeStrict(js)
			}
		};
	} else if (rf === 'json') {
		payload.text = { format: { type: 'json_object' } };
	} else if (rf && typeof rf === 'object') {
		// Allow callers to pass a fully-formed text.format object.
		payload.text = { format: rf };
	}

	// ── Web search tool ───────────────────────────────────────────────────────
	var ws = AI_LLM._normalizeWebSearch(options.webSearch);
	var tools = [];
	if (ws) {
		tools.push(self._buildWebSearchTool(ws));
	}
	// Caller-supplied additional tools (function calling etc.)
	if (Array.isArray(options.tools)) {
		// Merge: don't double-add web_search if already added
		options.tools.forEach(function (t) {
			if (t.type === 'web_search' || t.type === 'web_search_preview') {
				if (!ws) tools.push(t); // only if we haven't added ours
			} else {
				tools.push(t);
			}
		});
	}
	if (tools.length) {
		payload.tools = tools;
		if (options.tool_choice) payload.tool_choice = options.tool_choice;
	}

	return _post(
		'https://api.openai.com/v1/responses',
		{ 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
		payload,
		(options.timeout || 300) * 1000
	).then(function (res) {
		if (res.status < 200 || res.status >= 300) {
			throw new Error('AI.LLM.Openai: HTTP ' + res.status + ': ' + res.body.slice(0, 400));
		}
		var data;
		try { data = JSON.parse(res.body); } catch (e) {
			throw new Error('AI.LLM.Openai: non-JSON response');
		}
		if (data.error) {
			var msg = (typeof data.error === 'object' && data.error.message)
				? data.error.message : JSON.stringify(data.error);
			throw new Error('AI.LLM.Openai error: ' + msg);
		}
		var text      = self._extractText(data);
		var citations = options.includeCitations ? self._extractCitations(data) : null;
		return citations ? { text: text, citations: citations } : text;
	});
};

/**
 * Extract concatenated text from all output message blocks.
 * Skips web_search_call items — those are tool-execution records, not text.
 *
 * Handles structured-output refusals: when strict structured outputs are
 * enabled and the model declines, the Responses API returns a "refusal"
 * content block instead of "output_text". We surface that as an error rather
 * than letting it silently become an empty string.
 * @private
 */
AI_LLM.Openai.prototype._extractText = function (data) {
	var text = '';
	if (!data.output || !Array.isArray(data.output)) return text;
	for (var i = 0; i < data.output.length; i++) {
		var item = data.output[i];
		// Only process message items; skip web_search_call, function_call, etc.
		if (item.type !== 'message' || !Array.isArray(item.content)) continue;
		for (var j = 0; j < item.content.length; j++) {
			var block = item.content[j];
			if (block.type === 'refusal' && block.refusal) {
				throw new Error('AI.LLM.Openai: model refused: ' + block.refusal);
			}
			if (block.type === 'output_text' && typeof block.text === 'string') {
				text += (text ? '\n' : '') + block.text;
			}
		}
	}
	return text.trim();
};

/**
 * Extract url_citation annotations from output_text blocks.
 * Returns array of { url, title, startIndex, endIndex }.
 * @private
 */
AI_LLM.Openai.prototype._extractCitations = function (data) {
	var citations = [];
	if (!data.output || !Array.isArray(data.output)) return citations;
	data.output.forEach(function (item) {
		if (item.type !== 'message' || !Array.isArray(item.content)) return;
		item.content.forEach(function (block) {
			if (block.type !== 'output_text' || !Array.isArray(block.annotations)) return;
			block.annotations.forEach(function (ann) {
				if (ann.type === 'url_citation') {
					citations.push({
						url:        ann.url,
						title:      ann.title || '',
						startIndex: ann.start_index,
						endIndex:   ann.end_index
					});
				}
			});
		});
	});
	return citations;
};

module.exports = AI_LLM.Openai;
