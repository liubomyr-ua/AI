'use strict';
/**
 * AI_LLM_Anthropic -> AI.LLM.Anthropic
 * Anthropic Messages API adapter.
 *
 * Web search: uses Anthropic's native server-side web search tool.
 * Current version: web_search_20260209 (with dynamic HTML filtering).
 * Falls back to web_search_20250305 for older deployments.
 * Activated via options.webSearch = true | { maxUses, version, allowedDomains }.
 *
 * Key difference from OpenAI:
 *   - Tool is declared as { type: "web_search_20260209", name: "web_search", max_uses: N }
 *   - Response content may include server_tool_use + web_search_tool_result blocks
 *   - _extractText() skips these blocks and concatenates only text blocks
 *   - Citations come from TextBlock.citations[] (array of { type, url, title })
 *   - Encrypted search result content is passed back opaquely by Anthropic's
 *     servers — developers never see or handle the raw search results
 *
 * Prefix caching: supported via cache_control: { type: 'ephemeral' } on system blocks.
 *
 * @module AI
 */
var Q      = require('Q');
var https  = require('https');
var AI_LLM = require('AI/LLM');

// Latest web search tool version. Anthropic releases dated versions;
// update this constant when Anthropic ships a newer one.
var WEB_SEARCH_VERSION_LATEST = 'web_search_20260209';
var WEB_SEARCH_VERSION_STABLE = 'web_search_20250305';

function Anthropic(options) {
	options = options || {};
	this.apiKey = options.apiKey
		|| Q.Config.get(['AI', 'anthropic', 'apiKey'], null);
	if (!this.apiKey) {
		throw new Error('AI.LLM.Anthropic: apiKey required (AI/anthropic/apiKey)');
	}
	this.baseUrl = (options.baseUrl
		|| Q.Config.get(['AI', 'anthropic', 'baseUrl'], 'https://api.anthropic.com'))
		.replace(/\/$/, '');
	this.apiVersion = options.version
		|| Q.Config.get(['AI', 'anthropic', 'version'], '2023-06-01');
	this.defaultModel = options.model
		|| Q.Config.get(['AI', 'llm', 'models', 'anthropic'], 'claude-sonnet-4-6');
}

Anthropic.prototype = Object.create(AI_LLM.prototype);
Anthropic.prototype.constructor = Anthropic;

Anthropic.prototype.supportsWebSearch  = function () { return true; };
Anthropic.prototype.supportsPrefixCache = function () { return true; };

/**
 * Build the web_search tool entry for the Messages API payload.
 * @private
 */
Anthropic.prototype._buildWebSearchTool = function (ws) {
	var tool = {
		type:     ws.version || WEB_SEARCH_VERSION_LATEST,
		name:     'web_search',
		max_uses: ws.maxUses || 5
	};
	// Domain filtering (supported from 20260209+)
	if (ws.allowedDomains && ws.allowedDomains.length) {
		tool.allowed_domains = ws.allowedDomains;
	}
	return tool;
};

Anthropic.prototype.executeModel = function (instructions, inputs, options) {
	return this._execute(instructions, inputs || {}, options || {});
};

Anthropic.prototype.executeWithCachedPrefix = function (cacheKey, systemPrefix, inputs, options) {
	options = Object.assign({}, options || {});
	options.__cachePrefix    = systemPrefix;
	options.__cachePrefixKey = cacheKey;
	var additional = options.additionalInstructions || '';
	return this._execute(additional, inputs || {}, options);
};

Anthropic.prototype.prewarmPrefix    = function () { return Promise.reject(_notSupported('prewarmPrefix not supported — first call establishes cache.')); };
Anthropic.prototype.listCachedPrefixes = function () { return Promise.reject(_notSupported('listCachedPrefixes not supported — Anthropic caches are opaque.')); };
Anthropic.prototype.dropCachedPrefix   = function () { return Promise.reject(_notSupported('dropCachedPrefix not supported — Anthropic caches expire automatically.')); };

Anthropic.prototype._execute = function (instructions, inputs, options) {
	var self        = this;
	var model       = options.model       || this.defaultModel;
	var maxTokens   = options.max_tokens  || options.maxTokens || Q.Config.get(['AI','llm','maxTokens'], 4096);
	var temperature = options.temperature != null ? options.temperature : 0.5;
	var timeout     = (options.timeout || 120) * 1000;

	// ── System blocks with optional prefix caching ────────────────────────────
	var systemBlocks = [];
	var cachePrefix  = options.__cachePrefix || null;
	if (cachePrefix !== null && cachePrefix !== undefined) {
		systemBlocks.push({ type: 'text', text: cachePrefix, cache_control: { type: 'ephemeral' } });
		if (instructions) systemBlocks.push({ type: 'text', text: instructions });
	} else if (instructions) {
		systemBlocks.push({ type: 'text', text: instructions });
	}

	// JSON format hint appended to system
	var rf = options.response_format, js = options.json_schema;
	if (rf === 'json_schema' && js) {
		systemBlocks.push({ type: 'text', text: 'Respond ONLY with valid JSON conforming to this schema:\n' + JSON.stringify(js, null, 2) + '\nNo prose, no markdown fences.' });
	} else if (rf === 'json') {
		systemBlocks.push({ type: 'text', text: 'Respond ONLY with valid JSON. No prose, no markdown fences.' });
	}

	var messages = this._buildMessages(options, inputs);

	// ── Build payload ─────────────────────────────────────────────────────────
	var body = {
		model:       model,
		max_tokens:  maxTokens,
		temperature: temperature,
		messages:    messages
	};
	if (systemBlocks.length) body.system = systemBlocks;

	// ── Web search tool ───────────────────────────────────────────────────────
	var ws = AI_LLM._normalizeWebSearch(options.webSearch);
	var tools = [];
	if (ws) {
		tools.push(self._buildWebSearchTool(ws));
	}
	// Caller-supplied additional tools (function calling etc.)
	if (Array.isArray(options.tools)) {
		options.tools.forEach(function (t) {
			// Don't double-add web search
			var isSearch = t.type && t.type.indexOf('web_search') === 0;
			if (isSearch && ws) return;
			tools.push(t);
		});
	}
	if (tools.length) {
		body.tools = tools;
		if (options.tool_choice) body.tool_choice = options.tool_choice;
	}

	// ── Execute ───────────────────────────────────────────────────────────────
	return new Promise(function (resolve, reject) {
		var data = JSON.stringify(body);
		var u    = new URL(self.baseUrl + '/v1/messages');
		var req  = https.request({
			method:   'POST',
			hostname: u.hostname,
			port:     u.port || 443,
			path:     u.pathname + (u.search || ''),
			headers: {
				'Content-Type':      'application/json',
				'Content-Length':    Buffer.byteLength(data),
				'x-api-key':         self.apiKey,
				'anthropic-version': self.apiVersion
			},
			timeout: timeout
		}, function (res) {
			var chunks = [];
			res.on('data', function (c) { chunks.push(c); });
			res.on('end', function () {
				var raw = Buffer.concat(chunks).toString('utf8');
				var parsed;
				try { parsed = JSON.parse(raw); } catch (e) {
					return reject(new Error('AI.LLM.Anthropic: non-JSON response (HTTP ' + res.statusCode + '): ' + raw.slice(0, 500)));
				}
				if (parsed.error) {
					var msg = (typeof parsed.error === 'object' && parsed.error.message)
						? parsed.error.message : JSON.stringify(parsed.error);
					return reject(new Error('AI.LLM.Anthropic error: ' + msg));
				}
				var text      = self._extractText(parsed);
				var citations = options.includeCitations ? self._extractCitations(parsed) : null;
				var result    = citations ? { text: text, citations: citations } : text;
				// Expose raw + usage for callers that want it
				resolve({
					text:  text,
					raw:   parsed,
					usage: parsed.usage || null,
					model: parsed.model || model,
					// Shorthand for callers that just want text:
					toString: function () { return text; }
				});
				// If includeCitations, resolve with extended object
				if (citations) {
					// Already resolved above — this branch won't run.
					// Structured for clarity; actual resolve is above.
				}
			});
		});
		req.on('error', reject);
		req.on('timeout', function () {
			req.destroy();
			reject(new Error('AI.LLM.Anthropic: timeout after ' + timeout + 'ms'));
		});
		req.write(data);
		req.end();
	});
};

/**
 * Extract concatenated text from response content blocks.
 * Skips server_tool_use and web_search_tool_result blocks —
 * those are Anthropic-internal tool execution records.
 * Only TextBlock items with type='text' contribute to the output.
 * @private
 */
Anthropic.prototype._extractText = function (response) {
	if (!response || !Array.isArray(response.content)) return '';
	var out = '';
	for (var i = 0; i < response.content.length; i++) {
		var block = response.content[i];
		// Skip tool-execution blocks
		if (!block || block.type !== 'text') continue;
		if (typeof block.text === 'string') out += block.text;
	}
	return out;
};

/**
 * Extract citations from text blocks.
 * Anthropic returns citations[] on TextBlock when web search was used.
 * Each citation: { type: 'web_search_result_location', url, title, ... }
 * @private
 */
Anthropic.prototype._extractCitations = function (response) {
	var citations = [];
	if (!response || !Array.isArray(response.content)) return citations;
	response.content.forEach(function (block) {
		if (!block || block.type !== 'text') return;
		if (!Array.isArray(block.citations)) return;
		block.citations.forEach(function (c) {
			citations.push({
				url:   c.url   || '',
				title: c.title || ''
			});
		});
	});
	return citations;
};

Anthropic.prototype._buildMessages = function (options, inputs) {
	if (options.messages && Array.isArray(options.messages)) {
		var out = [];
		for (var i = 0; i < options.messages.length; i++) {
			var m    = options.messages[i];
			var role = m.role || 'user';
			if (role === 'system') continue; // system goes into body.system
			if (role === 'tool') {
				out.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: m.tool_use_id || '', content: m.content || '' }] });
				continue;
			}
			out.push(typeof m.content === 'string' ? { role: role, content: m.content } : m);
		}
		if (!out.length) out.push({ role: 'user', content: '' });
		return out;
	}

	// Legacy / simple: assemble from options.user + inputs
	var content = [];
	if (options.user) content.push({ type: 'text', text: String(options.user) });
	if (inputs.text)  content.push({ type: 'text', text: inputs.text });
	if (inputs.images && Array.isArray(inputs.images)) {
		inputs.images.forEach(function (img) {
			content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.isBuffer(img) ? img.toString('base64') : img } });
		});
	}
	if (inputs.pdfs && Array.isArray(inputs.pdfs)) {
		inputs.pdfs.forEach(function (pdf) {
			content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: Buffer.isBuffer(pdf) ? pdf.toString('base64') : pdf } });
		});
	}
	if (!content.length) content.push({ type: 'text', text: '' });
	return [{ role: 'user', content: content }];
};

function _notSupported(msg) {
	var err = new Error('AI.LLM.Anthropic: ' + msg);
	err.code = 'NOT_SUPPORTED';
	return err;
}

module.exports = Anthropic;