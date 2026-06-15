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
 * Structured outputs: when options.response_format === 'json_schema' and a
 * json_schema is supplied, the adapter sets output_config.format (GA native
 * structured outputs / constrained decoding) in addition to a prompt-level
 * JSON instruction. Toggle the native path with AI/anthropic/structuredOutputs
 * (default true) and, if your account is still on the beta path, set
 * AI/anthropic/structuredOutputsBeta to the beta header value.
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

	// ── JSON / structured output ───────────────────────────────────────────────
	// Keep the prompt-level instruction as reinforcement / fallback, AND, when
	// enabled, set output_config.format below for native constrained decoding.
	var rf = options.response_format, js = options.json_schema;
	var nativeFormat = null;
	var useNativeStructured = (options.nativeStructured !== undefined)
		? options.nativeStructured
		: Q.Config.get(['AI', 'anthropic', 'structuredOutputs'], true);

	if (rf === 'json_schema' && js) {
		systemBlocks.push({ type: 'text', text: 'Respond ONLY with valid JSON conforming to this schema:\n' + JSON.stringify(js, null, 2) + '\nNo prose, no markdown fences.' });
		if (useNativeStructured) {
			nativeFormat = { type: 'json_schema', schema: AI_LLM.makeStrict(js) };
		}
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

	// Native structured outputs (GA): output_config.format
	if (nativeFormat) body.output_config = { format: nativeFormat };

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

		var headers = {
			'Content-Type':      'application/json',
			'Content-Length':    Buffer.byteLength(data),
			'x-api-key':         self.apiKey,
			'anthropic-version': self.apiVersion
		};
		// Some accounts/models still require the beta header for structured
		// outputs rather than the GA output_config path. Opt in via config.
		if (nativeFormat) {
			var betaHeader = Q.Config.get(['AI', 'anthropic', 'structuredOutputsBeta'], null);
			if (betaHeader) headers['anthropic-beta'] = betaHeader;
		}

		var req  = https.request({
			method:   'POST',
			hostname: u.hostname,
			port:     u.port || 443,
			path:     u.pathname + (u.search || ''),
			headers:  headers,
			timeout:  timeout
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
				var citations = self._extractCitations(parsed);
				resolve({
					text:      text,
					citations: citations,   // [] when web search wasn't used / produced none
					raw:       parsed,
					usage:     parsed.usage || null,
					model:     parsed.model || model,
					toString:  function () { return text; }
				});
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
	var seen = {};
	if (!response || !Array.isArray(response.content)) return citations;
	response.content.forEach(function (block) {
		if (!block || block.type !== 'text') return;
		if (!Array.isArray(block.citations)) return;
		block.citations.forEach(function (c) {
			var url = c.url || '';
			if (!url || seen[url]) return;
			seen[url] = true;
			var domain = '', favicon = '';
			try {
				var u = new URL(url);
				domain = u.hostname.replace(/^www\./, '');
				favicon = u.protocol + '//' + u.hostname + '/favicon.ico';
			} catch (e) {}
			citations.push({
				url:     url,
				title:   c.title      || '',
				quote:   (c.cited_text || '').slice(0, 400),
				domain:  domain,
				favicon: favicon
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
			// Detect the real media type from the bytes rather than hardcoding
			// png — Anthropic rejects a JPEG labeled as image/png.
			content.push({ type: 'image', source: { type: 'base64', media_type: _imageMediaType(img), data: Buffer.isBuffer(img) ? img.toString('base64') : img } });
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

/**
 * Detect image media type from a Buffer or base64 string.
 * Anthropic accepts png, jpeg, gif and webp. Falls back to image/jpeg.
 * @private
 */
function _imageMediaType(img) {
	if (Buffer.isBuffer(img)) {
		var h = img;
		if (h.length >= 8 && h[0] === 0x89 && h[1] === 0x50 && h[2] === 0x4E && h[3] === 0x47) return 'image/png';
		if (h.length >= 3 && h[0] === 0xFF && h[1] === 0xD8 && h[2] === 0xFF) return 'image/jpeg';
		if (h.length >= 4 && h[0] === 0x47 && h[1] === 0x49 && h[2] === 0x46) return 'image/gif';
		if (h.length >= 12 && h.slice(0, 4).toString('ascii') === 'RIFF' && h.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
		return 'image/jpeg';
	}
	if (typeof img === 'string') {
		if (img.indexOf('iVBORw0KGgo') === 0) return 'image/png';
		if (img.indexOf('/9j/') === 0) return 'image/jpeg';
		if (img.indexOf('R0lGOD') === 0) return 'image/gif';
		if (img.indexOf('UklGR') === 0) return 'image/webp';
		return 'image/jpeg';
	}
	return 'image/jpeg';
}

function _notSupported(msg) {
	var err = new Error('AI.LLM.Anthropic: ' + msg);
	err.code = 'NOT_SUPPORTED';
	return err;
}

module.exports = Anthropic;
