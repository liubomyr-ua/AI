"use strict";

/**
 * AI.LLM.Local — local model serving adapter with KV cache controls (JS).
 *
 * Parallels AI_LLM_Local.php. Same subtypes (vllm, llama-cpp, ollama,
 * lm-studio, generic), same config keys, same KV cache semantics.
 *
 * Subtype selection drives the prefix-caching, prewarm, list, and drop
 * behavior — see Local.php docblock for full details.
 *
 * SSRF: enforces AI/local/allowedHosts whitelist to prevent config-drift
 * SSRF against arbitrary internal endpoints.
 */
var Q = require('Q');
var http = require('http');
var https = require('https');

function Local(options) {
	options = options || {};
	var url = options.url || Q.Config.get(['AI', 'local', 'url']);
	if (!url) throw new Error('AI.LLM.Local: url required (AI/local/url)');
	this.baseUrl = url.replace(/\/$/, '');
	this.apiKey  = options.apiKey
		|| Q.Config.get(['AI', 'local', 'apiKey'], 'sk-local-dummy');
	this.subtype = options.subtype
		|| Q.Config.get(['AI', 'local', 'subtype'], 'generic');
	this.defaultModel = options.model
		|| Q.Config.get(['AI', 'local', 'model'],
			Q.Config.get(['AI', 'llm', 'models', 'local'], 'default'));
	this.cacheTracker = {};
	this._validateHost(this.baseUrl);
}

Local.prototype.supportsPrefixCache = function () {
	return ['vllm', 'llama-cpp', 'sglang'].indexOf(this.subtype) !== -1;
};

Local.prototype.executeModel = function (instructions, inputs, options) {
	return this._execute(instructions || '', inputs || {}, options || {});
};

Local.prototype.executeWithCachedPrefix = function (cacheKey, systemPrefix, inputs, options) {
	options = options || {};
	options.__cachePrefix    = systemPrefix;
	options.__cachePrefixKey = cacheKey;
	this.cacheTracker[cacheKey] = {
		prefixLength: systemPrefix.length,
		lastUsed:     Date.now() / 1000
	};
	return this._execute(options.additionalInstructions || '', inputs || {}, options);
};

Local.prototype.prewarmPrefix = function (cacheKey, systemPrefix, options) {
	var self = this;
	if (!this.supportsPrefixCache()) {
		return Promise.reject(_notSupported(
			'prewarmPrefix requires subtype with native cache (vllm/llama-cpp/sglang); current: '
			+ this.subtype));
	}
	var opts = Object.assign({}, options || {}, {
		max_tokens:  1,
		temperature: 0,
		__cachePrefix:    systemPrefix,
		__cachePrefixKey: cacheKey
	});
	return this._execute('', {}, opts).then(function () {
		self.cacheTracker[cacheKey] = {
			prefixLength: systemPrefix.length,
			lastUsed:     Date.now() / 1000,
			prewarmed:    true
		};
		return true;
	});
};

Local.prototype.listCachedPrefixes = function () {
	var self = this;
	if (this.subtype === 'llama-cpp') {
		return this._get('/slots').then(function (slots) {
			var out = {};
			if (Array.isArray(slots)) {
				slots.forEach(function (slot) {
					if (slot.prompt) {
						var key = slot.cache_key || ('slot_' + (slot.id != null ? slot.id : '?'));
						out[key] = {
							slotId:       slot.id,
							prefixLength: slot.prompt.length
						};
					}
				});
			}
			return out;
		});
	}
	return Promise.resolve(this.cacheTracker);
};

Local.prototype.dropCachedPrefix = function (cacheKey) {
	var self = this;
	if (this.subtype === 'llama-cpp' && this.cacheTracker[cacheKey]
		&& this.cacheTracker[cacheKey].slotId != null) {
		var slotId = this.cacheTracker[cacheKey].slotId;
		return this._post('/slots/' + slotId + '?action=erase', {}).then(function () {
			delete self.cacheTracker[cacheKey];
			return true;
		});
	}
	if (this.cacheTracker[cacheKey]) {
		delete this.cacheTracker[cacheKey];
		return Promise.resolve(true);
	}
	return Promise.resolve(false);
};

Local.prototype._execute = function (instructions, inputs, options) {
	var self = this;
	var model = options.model || this.defaultModel;
	var maxTokens   = options.max_tokens || options.maxTokens
		|| Q.Config.get(['AI', 'llm', 'maxTokens'], 4096);
	var temperature = options.temperature != null ? options.temperature : 0.7;
	var timeout     = (options.timeout || 120) * 1000;

	var messages = this._buildMessages(instructions, options, inputs);
	var body = {
		model:       model,
		messages:    messages,
		max_tokens:  maxTokens,
		temperature: temperature
	};

	var responseFormat = options.response_format || null;
	if (responseFormat === 'json' || responseFormat === 'json_object') {
		body.response_format = { type: 'json_object' };
	} else if (responseFormat === 'json_schema' && options.json_schema) {
		if (this.subtype === 'vllm') {
			body.guided_json = options.json_schema;
		} else {
			body.response_format = {
				type: 'json_schema',
				json_schema: { name: 'response', schema: options.json_schema, strict: true }
			};
		}
	}

	this._applyExtensions(body, options);
	if (options.__cachePrefixKey) this._applyPrefixCache(body, options);

	return this._post('/v1/chat/completions', body, timeout).then(function (resp) {
		if (resp.error) {
			var msg = (typeof resp.error === 'object' && resp.error.message)
				? resp.error.message
				: JSON.stringify(resp.error);
			throw new Error('AI.LLM.Local error: ' + msg);
		}
		var content = '';
		if (resp.choices && resp.choices[0] && resp.choices[0].message
			&& resp.choices[0].message.content) {
			content = resp.choices[0].message.content;
		}
		return { text: content, raw: resp, usage: resp.usage || null, model: resp.model || model };
	});
};

Local.prototype._buildMessages = function (instructions, options, inputs) {
	var messages = [];
	if (instructions) messages.push({ role: 'system', content: instructions });
	if (options.messages && Array.isArray(options.messages)) {
		options.messages.forEach(function (m) { messages.push(m); });
	} else if (options.user) {
		messages.push({ role: 'user', content: String(options.user) });
	}
	if (inputs.images && Array.isArray(inputs.images) && options._multimodal) {
		var content = [{ type: 'text', text: options.user || '' }];
		inputs.images.forEach(function (img) {
			var b64 = Buffer.isBuffer(img) ? img.toString('base64')
				: typeof img === 'string' ? Buffer.from(img).toString('base64') : '';
			content.push({
				type: 'image_url',
				image_url: { url: 'data:image/png;base64,' + b64 }
			});
		});
		var last = messages.length - 1;
		if (last >= 0 && messages[last].role === 'user') {
			messages[last] = { role: 'user', content: content };
		} else {
			messages.push({ role: 'user', content: content });
		}
	}
	return messages;
};

Local.prototype._applyExtensions = function (body, options) {
	switch (this.subtype) {
		case 'vllm':
			if (options.logprobs) body.logprobs = options.logprobs;
			if (options.top_logprobs) body.top_logprobs = options.top_logprobs;
			break;
		case 'llama-cpp':
			if (options.slot_id != null) body.id_slot = options.slot_id;
			if (options.n_predict != null) body.n_predict = options.n_predict;
			break;
		case 'ollama':
			if (options.keep_alive != null) body.keep_alive = options.keep_alive;
			break;
	}
};

Local.prototype._applyPrefixCache = function (body, options) {
	var cacheKey = options.__cachePrefixKey;
	var prefix   = options.__cachePrefix;
	if (prefix) {
		body.messages = [{ role: 'system', content: prefix }].concat(body.messages);
	}
	switch (this.subtype) {
		case 'vllm':
			body.cache_key = cacheKey;
			break;
		case 'llama-cpp':
			body.cache_prompt = true;
			if (this.cacheTracker[cacheKey] && this.cacheTracker[cacheKey].slotId != null) {
				body.id_slot = this.cacheTracker[cacheKey].slotId;
			}
			break;
	}
};

Local.prototype._validateHost = function (url) {
	var allowed = Q.Config.get(['AI', 'local', 'allowedHosts'],
		['localhost', '127.0.0.1', '::1']);
	var u;
	try { u = new URL(url); } catch (e) {
		throw new Error('AI.LLM.Local: invalid url: ' + url);
	}
	var host = u.hostname.toLowerCase();
	var ok = allowed.some(function (h) { return h.toLowerCase() === host; });
	if (!ok) {
		throw new Error('AI.LLM.Local: host "' + host
			+ '" not in AI/local/allowedHosts. Add it to allow this endpoint.');
	}
};

Local.prototype._post = function (path, body, timeout) {
	return this._request('POST', path, body, timeout);
};

Local.prototype._get = function (path, timeout) {
	return this._request('GET', path, null, timeout || 30000);
};

Local.prototype._request = function (method, path, body, timeout) {
	var self = this;
	timeout = timeout || 120000;
	return new Promise(function (resolve, reject) {
		var u = new URL(self.baseUrl + path);
		var lib = u.protocol === 'https:' ? https : http;
		var headers = {};
		if (self.apiKey) headers['Authorization'] = 'Bearer ' + self.apiKey;
		var data = null;
		if (body !== null && body !== undefined) {
			data = JSON.stringify(body);
			headers['Content-Type']   = 'application/json';
			headers['Content-Length'] = Buffer.byteLength(data);
		}
		var req = lib.request({
			method:   method,
			hostname: u.hostname,
			port:     u.port || (u.protocol === 'https:' ? 443 : 80),
			path:     u.pathname + (u.search || ''),
			headers:  headers,
			timeout:  timeout
		}, function (res) {
			var chunks = [];
			res.on('data', function (c) { chunks.push(c); });
			res.on('end', function () {
				var raw = Buffer.concat(chunks).toString('utf8');
				if (!raw) return resolve({});
				try { resolve(JSON.parse(raw)); }
				catch (e) {
					reject(new Error('AI.LLM.Local: non-JSON response (status '
						+ res.statusCode + '): ' + raw.slice(0, 500)));
				}
			});
		});
		req.on('error', reject);
		req.on('timeout', function () {
			req.destroy();
			reject(new Error('AI.LLM.Local: request timeout after ' + timeout + 'ms'));
		});
		if (data) req.write(data);
		req.end();
	});
};

function _notSupported(msg) {
	var err = new Error('AI.LLM.Local: ' + msg);
	err.code = 'NOT_SUPPORTED';
	return err;
}

module.exports = Local;
