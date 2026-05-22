"use strict";

/**
 * AI.LLM.VertexAi — Google Cloud Vertex AI adapter (JS).
 *
 * Parallels AI_LLM_VertexAi.php. Dispatches by model name's publisher
 * segment:
 *   publishers/google/...    → Gemini generateContent
 *   publishers/anthropic/... → rawPredict with messages format
 *   publishers/meta/...      → OpenAI-compat chat completions
 *
 * Auth: either accessToken in options (caller-managed), or
 * credentialsPath pointing at a service account JSON, or
 * credentialsPath="metadata" for Workload Identity on GKE/Cloud Run.
 *
 * For browser-side use, prefer the PHP adapter behind a server route —
 * Vertex API keys / service accounts should never be in the browser.
 * This JS adapter is for Node-side capability/tool code.
 */
var Q = require('Q');
var https = require('https');
var fs = require('fs');
var crypto = require('crypto');

function VertexAi(options) {
	options = options || {};
	this.projectId = options.projectId
		|| Q.Config.get(['AI', 'vertex', 'projectId']);
	if (!this.projectId) {
		throw new Error('AI.LLM.VertexAi: projectId required (AI/vertex/projectId)');
	}
	this.location = options.location
		|| Q.Config.get(['AI', 'vertex', 'location'], 'us-central1');
	this.credentialsPath = options.credentialsPath
		|| Q.Config.get(['AI', 'vertex', 'credentialsPath'], null);
	this.accessToken = options.accessToken || null;
	this.tokenExpiry = this.accessToken ? (Date.now() / 1000 + 3600) : 0;
	this.defaultModel = options.model
		|| Q.Config.get(['AI', 'llm', 'models', 'vertex'],
			'publishers/google/models/gemini-2.5-flash');
}

VertexAi.prototype.supportsPrefixCache = function () {
	return true; // Depends on model; conservatively true.
};

VertexAi.prototype.executeModel = function (instructions, inputs, options) {
	var model = (options && options.model) || this.defaultModel;
	var publisher = this._detectPublisher(model);
	switch (publisher) {
		case 'anthropic': return this._executeAnthropic(model, instructions, inputs || {}, options || {});
		case 'meta':
		case 'mistralai': return this._executeOpenAICompat(model, instructions, inputs || {}, options || {});
		default:          return this._executeGemini(model, instructions, inputs || {}, options || {});
	}
};

VertexAi.prototype.executeWithCachedPrefix = function (cacheKey, systemPrefix, inputs, options) {
	options = options || {};
	var model = options.model || this.defaultModel;
	var publisher = this._detectPublisher(model);

	if (publisher === 'anthropic') {
		options.__cachePrefix    = systemPrefix;
		options.__cachePrefixKey = cacheKey;
		return this._executeAnthropic(model, options.additionalInstructions || '', inputs || {}, options);
	}
	// Gemini caches via cachedContents resource — separate code path not
	// implemented here. Fall back to in-instruction concat.
	// Open-weight models on Vertex don't have prefix caching at the API level.
	var prefixed = (systemPrefix ? systemPrefix + '\n\n' : '')
		+ (options.additionalInstructions || '');
	if (publisher === 'google') {
		return this._executeGemini(model, prefixed, inputs || {}, options);
	}
	return this._executeOpenAICompat(model, prefixed, inputs || {}, options);
};

VertexAi.prototype.prewarmPrefix = function () {
	return Promise.reject(_notSupported(
		'prewarmPrefix not supported via this adapter. Use Vertex cachedContents API directly for Gemini.'));
};
VertexAi.prototype.listCachedPrefixes = function () {
	return Promise.reject(_notSupported('listCachedPrefixes not supported (server-managed).'));
};
VertexAi.prototype.dropCachedPrefix = function () {
	return Promise.reject(_notSupported('dropCachedPrefix not supported via this adapter.'));
};

VertexAi.prototype._detectPublisher = function (model) {
	if (model.indexOf('publishers/anthropic/') !== -1) return 'anthropic';
	if (model.indexOf('publishers/meta/')      !== -1) return 'meta';
	if (model.indexOf('publishers/mistralai/') !== -1) return 'mistralai';
	return 'google';
};

VertexAi.prototype._executeGemini = function (model, instructions, inputs, options) {
	var self = this;
	var endpoint = 'https://' + this.location + '-aiplatform.googleapis.com/v1/projects/'
		+ this.projectId + '/locations/' + this.location + '/' + model + ':generateContent';
	var contents = this._buildGeminiContents(options, inputs);
	var body = {
		contents: contents,
		generationConfig: {
			temperature: options.temperature != null ? options.temperature : 0.5,
			maxOutputTokens: options.max_tokens || options.maxTokens
				|| Q.Config.get(['AI', 'llm', 'maxTokens'], 4096)
		}
	};
	if (instructions) {
		body.systemInstruction = { parts: [{ text: instructions }] };
	}
	if (options.json_schema) {
		body.generationConfig.responseMimeType = 'application/json';
		body.generationConfig.responseSchema = options.json_schema;
	}
	return this._authedPost(endpoint, body, (options.timeout || 120) * 1000)
		.then(function (resp) {
			if (resp.error) throw new Error('AI.LLM.VertexAi (Gemini): '
				+ (typeof resp.error === 'object' ? JSON.stringify(resp.error) : resp.error));
			var text = '';
			if (resp.candidates && resp.candidates[0] && resp.candidates[0].content
				&& resp.candidates[0].content.parts) {
				resp.candidates[0].content.parts.forEach(function (p) {
					if (p.text) text += p.text;
				});
			}
			return { text: text, raw: resp, usage: resp.usageMetadata || null, model: model };
		});
};

VertexAi.prototype._executeAnthropic = function (model, instructions, inputs, options) {
	var self = this;
	var endpoint = 'https://' + this.location + '-aiplatform.googleapis.com/v1/projects/'
		+ this.projectId + '/locations/' + this.location + '/' + model + ':rawPredict';

	var systemBlocks = [];
	if (options.__cachePrefix) {
		systemBlocks.push({
			type: 'text', text: options.__cachePrefix,
			cache_control: { type: 'ephemeral' }
		});
		if (instructions) systemBlocks.push({ type: 'text', text: instructions });
	} else if (instructions) {
		systemBlocks.push({ type: 'text', text: instructions });
	}

	var messages = this._buildAnthropicMessages(options, inputs);
	var body = {
		anthropic_version: 'vertex-2023-10-16',
		max_tokens:  options.max_tokens || options.maxTokens
			|| Q.Config.get(['AI', 'llm', 'maxTokens'], 4096),
		temperature: options.temperature != null ? options.temperature : 0.5,
		messages:    messages
	};
	if (systemBlocks.length) body.system = systemBlocks;

	return this._authedPost(endpoint, body, (options.timeout || 120) * 1000)
		.then(function (resp) {
			if (resp.error) throw new Error('AI.LLM.VertexAi (Anthropic): '
				+ (typeof resp.error === 'object' ? JSON.stringify(resp.error) : resp.error));
			var text = '';
			if (resp.content) resp.content.forEach(function (b) {
				if (b.type === 'text' && b.text) text += b.text;
			});
			return { text: text, raw: resp, usage: resp.usage || null, model: model };
		});
};

VertexAi.prototype._executeOpenAICompat = function (model, instructions, inputs, options) {
	var endpoint = 'https://' + this.location + '-aiplatform.googleapis.com/v1/projects/'
		+ this.projectId + '/locations/' + this.location
		+ '/endpoints/openapi/chat/completions';

	var messages = [];
	if (instructions) messages.push({ role: 'system', content: instructions });
	if (options.messages && Array.isArray(options.messages)) {
		options.messages.forEach(function (m) { messages.push(m); });
	} else if (options.user) {
		messages.push({ role: 'user', content: String(options.user) });
	}

	var body = {
		model:       model,
		messages:    messages,
		max_tokens:  options.max_tokens || options.maxTokens
			|| Q.Config.get(['AI', 'llm', 'maxTokens'], 4096),
		temperature: options.temperature != null ? options.temperature : 0.5
	};

	return this._authedPost(endpoint, body, (options.timeout || 120) * 1000)
		.then(function (resp) {
			if (resp.error) throw new Error('AI.LLM.VertexAi (OpenAI-compat): '
				+ (typeof resp.error === 'object' ? JSON.stringify(resp.error) : resp.error));
			var content = '';
			if (resp.choices && resp.choices[0] && resp.choices[0].message
				&& resp.choices[0].message.content) {
				content = resp.choices[0].message.content;
			}
			return { text: content, raw: resp, usage: resp.usage || null, model: model };
		});
};

VertexAi.prototype._buildGeminiContents = function (options, inputs) {
	var contents = [];
	if (options.messages && Array.isArray(options.messages)) {
		options.messages.forEach(function (m) {
			if (m.role === 'system') return;
			var role = m.role === 'assistant' ? 'model' : 'user';
			var parts = [];
			if (typeof m.content === 'string') parts.push({ text: m.content });
			else if (Array.isArray(m.content)) {
				m.content.forEach(function (c) {
					if (c.type === 'text') parts.push({ text: c.text });
				});
			}
			if (parts.length) contents.push({ role: role, parts: parts });
		});
		if (!contents.length) contents.push({ role: 'user', parts: [{ text: '' }] });
	} else {
		var parts = [];
		if (options.user) parts.push({ text: String(options.user) });
		if (inputs.images && Array.isArray(inputs.images)) {
			inputs.images.forEach(function (img) {
				var b64 = Buffer.isBuffer(img) ? img.toString('base64')
					: typeof img === 'string' ? Buffer.from(img).toString('base64')
					: '';
				parts.push({ inline_data: { mime_type: 'image/png', data: b64 } });
			});
		}
		if (!parts.length) parts.push({ text: '' });
		contents.push({ role: 'user', parts: parts });
	}
	return contents;
};

VertexAi.prototype._buildAnthropicMessages = function (options, inputs) {
	if (options.messages && Array.isArray(options.messages)) {
		var out = [];
		options.messages.forEach(function (m) {
			if (m.role !== 'system') out.push(m);
		});
		if (!out.length) out.push({ role: 'user', content: '' });
		return out;
	}
	var content = [];
	if (options.user) content.push({ type: 'text', text: String(options.user) });
	if (inputs.images && Array.isArray(inputs.images)) {
		inputs.images.forEach(function (img) {
			var b64 = Buffer.isBuffer(img) ? img.toString('base64')
				: typeof img === 'string' ? Buffer.from(img).toString('base64')
				: '';
			content.push({
				type: 'image',
				source: { type: 'base64', media_type: 'image/png', data: b64 }
			});
		});
	}
	if (!content.length) content = [{ type: 'text', text: '' }];
	return [{ role: 'user', content: content }];
};

VertexAi.prototype._authedPost = function (url, body, timeout) {
	var self = this;
	return this._getAccessToken().then(function (token) {
		return new Promise(function (resolve, reject) {
			var data = JSON.stringify(body);
			var u = new URL(url);
			var req = https.request({
				method: 'POST',
				hostname: u.hostname,
				port: u.port || 443,
				path: u.pathname + (u.search || ''),
				headers: {
					'Content-Type':   'application/json',
					'Content-Length': Buffer.byteLength(data),
					'Authorization':  'Bearer ' + token
				},
				timeout: timeout
			}, function (res) {
				var chunks = [];
				res.on('data', function (c) { chunks.push(c); });
				res.on('end', function () {
					var raw = Buffer.concat(chunks).toString('utf8');
					if (!raw) return resolve({});
					try { resolve(JSON.parse(raw)); }
					catch (e) {
						reject(new Error('AI.LLM.VertexAi: non-JSON response (status '
							+ res.statusCode + '): ' + raw.slice(0, 500)));
					}
				});
			});
			req.on('error', reject);
			req.on('timeout', function () {
				req.destroy();
				reject(new Error('AI.LLM.VertexAi: request timeout'));
			});
			req.write(data);
			req.end();
		});
	});
};

VertexAi.prototype._getAccessToken = function () {
	var self = this;
	var now = Date.now() / 1000;
	if (this.accessToken && this.tokenExpiry > now + 60) {
		return Promise.resolve(this.accessToken);
	}
	if (!this.credentialsPath) {
		return Promise.reject(new Error(
			'AI.LLM.VertexAi: credentialsPath required (or pass accessToken in options). '
			+ 'For Workload Identity, set credentialsPath="metadata".'));
	}
	if (this.credentialsPath === 'metadata') {
		return this._fetchMetadataToken();
	}
	return this._exchangeServiceAccountJwt();
};

VertexAi.prototype._fetchMetadataToken = function () {
	var self = this;
	return new Promise(function (resolve, reject) {
		var http = require('http');
		var req = http.request({
			method:   'GET',
			hostname: 'metadata.google.internal',
			path:     '/computeMetadata/v1/instance/service-accounts/default/token',
			headers:  { 'Metadata-Flavor': 'Google' },
			timeout:  5000
		}, function (res) {
			var chunks = [];
			res.on('data', function (c) { chunks.push(c); });
			res.on('end', function () {
				try {
					var parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
					if (!parsed.access_token) {
						return reject(new Error('AI.LLM.VertexAi: metadata returned no token'));
					}
					self.accessToken = parsed.access_token;
					self.tokenExpiry = Date.now() / 1000 + (parsed.expires_in || 3600);
					resolve(self.accessToken);
				} catch (e) {
					reject(new Error('AI.LLM.VertexAi: metadata response parse: ' + e.message));
				}
			});
		});
		req.on('error', reject);
		req.on('timeout', function () { req.destroy(); reject(new Error('metadata timeout')); });
		req.end();
	});
};

VertexAi.prototype._exchangeServiceAccountJwt = function () {
	var self = this;
	return new Promise(function (resolve, reject) {
		var creds;
		try {
			creds = JSON.parse(fs.readFileSync(self.credentialsPath, 'utf8'));
		} catch (e) {
			return reject(new Error('AI.LLM.VertexAi: cannot read credentials at '
				+ self.credentialsPath + ': ' + e.message));
		}
		if (!creds.private_key || !creds.client_email) {
			return reject(new Error('AI.LLM.VertexAi: invalid service account credentials'));
		}
		var now = Math.floor(Date.now() / 1000);
		function b64u(buf) {
			return Buffer.from(buf).toString('base64')
				.replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
		}
		var header  = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
		var payload = b64u(JSON.stringify({
			iss:   creds.client_email,
			scope: 'https://www.googleapis.com/auth/cloud-platform',
			aud:   'https://oauth2.googleapis.com/token',
			exp:   now + 3600,
			iat:   now
		}));
		var sigInput = header + '.' + payload;
		var signer = crypto.createSign('RSA-SHA256');
		signer.update(sigInput);
		var signature = b64u(signer.sign(creds.private_key));
		var jwt = sigInput + '.' + signature;

		var data = 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + encodeURIComponent(jwt);
		var req = https.request({
			method: 'POST',
			hostname: 'oauth2.googleapis.com',
			path: '/token',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
				'Content-Length': Buffer.byteLength(data)
			},
			timeout: 10000
		}, function (res) {
			var chunks = [];
			res.on('data', function (c) { chunks.push(c); });
			res.on('end', function () {
				try {
					var parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
					if (!parsed.access_token) {
						return reject(new Error('AI.LLM.VertexAi: JWT exchange failed: '
							+ JSON.stringify(parsed)));
					}
					self.accessToken = parsed.access_token;
					self.tokenExpiry = now + (parsed.expires_in || 3600);
					resolve(self.accessToken);
				} catch (e) {
					reject(new Error('AI.LLM.VertexAi: JWT exchange parse error: ' + e.message));
				}
			});
		});
		req.on('error', reject);
		req.on('timeout', function () { req.destroy(); reject(new Error('JWT exchange timeout')); });
		req.write(data);
		req.end();
	});
};

function _notSupported(msg) {
	var err = new Error('AI.LLM.VertexAi: ' + msg);
	err.code = 'NOT_SUPPORTED';
	return err;
}

module.exports = VertexAi;
