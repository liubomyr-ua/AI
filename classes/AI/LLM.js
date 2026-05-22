'use strict';
/**
 * AI/LLM — provider-agnostic LLM execution layer.
 *
 * Mirrors PHP AI_LLM layout:
 *   classes/AI/LLM.php             (base + factory + helpers)
 *   classes/AI/LLM/<Adapter>.php   (one per provider)
 *
 * Core contract:
 *   executeModel(instructions, inputs, options) → Promise<string|object>
 *
 * Web search support:
 *   Each adapter that supports built-in web search declares
 *   supportsWebSearch() → true and accepts options.webSearch config.
 *
 *   options.webSearch = true | { maxUses, contextSize, allowedDomains, userLocation }
 *
 *   When webSearch is enabled the adapter injects the provider-specific
 *   web search tool into the request. The response text is extracted from
 *   tool-interleaved output transparently — callers get a plain string
 *   (or object with .text + .citations if options.includeCitations=true).
 *
 * NER-first pipeline helpers:
 *   AI_LLM.extractEntities(text) — lightweight regex NER, no LLM cost.
 *   AI_LLM.lookupStreams(entities, options) — Qbix stream title search.
 *   AI_LLM.buildSearchQueries(entities) — structured query list for
 *     Pexels/Pixabay/archive lookups without an LLM call.
 *
 * @module AI
 */

var Q = require('Q');
var path = require('path');

// ── AI_LLM base ───────────────────────────────────────────────────────────────

function AI_LLM() {}
module.exports = AI_LLM;

/**
 * Factory — mirrors PHP AI_LLM::create().
 * @param {string|object|function} adapter
 * @param {object} [options]
 * @returns {AI_LLM|null}
 */
AI_LLM.create = function (adapter, options) {
	if (!adapter) return null;
	if (typeof adapter === 'object') return adapter;
	if (typeof adapter === 'function') return new adapter(options || {});
	var sanitized = adapter.replace(/[^a-z0-9]+/gi, ' ').trim();
	var suffix = sanitized.replace(/\s+(.)/g, function (_, c) { return c.toUpperCase(); });
	suffix = suffix.charAt(0).toUpperCase() + suffix.slice(1);
	var cls = AI_LLM[suffix];
	if (cls) return new cls(options || {});
	try {
		var Cls = require(path.join(__dirname, 'LLM', suffix + '.js'));
		AI_LLM[suffix] = Cls;
		return new Cls(options || {});
	} catch (e) {
		return null;
	}
};

/**
 * Route to an LLM adapter by deployment-configured route name.
 *
 * Config shape:
 *   AI/llm/routes:    { routeName: providerName, ... }
 *   AI/llm/providers: { providerName: { class, config }, ... }
 *   AI/llm/default:   fallback providerName
 *
 * Route names used by the intelligence pipeline:
 *   'fast'   — entity detection, private coaching  (mini/haiku)
 *   'smart'  — proposals with web search           (4.1/sonnet)
 *   'search' — alias for smart, web search always on
 *   'vision' — image/frame analysis
 *
 * @param {string} routeName
 * @param {object} [options]  Merged over provider config; caller wins.
 * @returns {AI_LLM|null}
 */
AI_LLM.route = function (routeName, options) {
	options = options || {};
	var routes    = Q.Config.get(['AI', 'llm', 'routes'],    {}) || {};
	var providers = Q.Config.get(['AI', 'llm', 'providers'], {}) || {};
	var deflt     = Q.Config.get(['AI', 'llm', 'default'],   null);

	var providerName = routes[routeName];
	if (!providerName) providerName = deflt;
	if (!providerName) {
		var names = Object.keys(providers);
		providerName = names.length ? names[0] : null;
	}
	if (!providerName) return null;

	var def = providers[providerName];
	if (!def) return AI_LLM.create(providerName, options);
	if (!def.class) return null;

	// 'search' route implies webSearch: true unless caller overrides
	if (routeName === 'search' && options.webSearch === undefined) {
		options = Object.assign({ webSearch: true }, options);
	}

	return AI_LLM.create(def.class, Object.assign({}, def.config || {}, options));
};

AI_LLM.listRoutes    = function () { return Object.keys(Q.Config.get(['AI','llm','routes'],    {}) || {}); };
AI_LLM.listProviders = function () { return Object.keys(Q.Config.get(['AI','llm','providers'], {}) || {}); };

// ── Web search capability declaration ─────────────────────────────────────────

/**
 * Adapters that support built-in web search override this.
 * @returns {boolean}
 */
AI_LLM.prototype.supportsWebSearch = function () { return false; };

/**
 * Normalise options.webSearch into a canonical config object.
 * Accepts: true | false | { maxUses, contextSize, allowedDomains, userLocation }
 * @private
 */
AI_LLM._normalizeWebSearch = function (webSearch) {
	if (!webSearch) return null;
	if (webSearch === true) {
		return { maxUses: 5, contextSize: 'medium', allowedDomains: null, userLocation: null };
	}
	return {
		maxUses:        webSearch.maxUses        || 5,
		contextSize:    webSearch.contextSize    || 'medium',
		allowedDomains: webSearch.allowedDomains || null,
		userLocation:   webSearch.userLocation   || null
	};
};

// ── NER helpers (no LLM cost) ─────────────────────────────────────────────────

/**
 * Lightweight regex-based named entity extraction.
 * Runs before any LLM call in the transcript pipeline.
 * Returns typed candidate entities for graph lookup and Pexels/search queries.
 *
 * Does NOT replace LLM-based entity detection — it feeds INTO it, giving the
 * LLM pre-structured input rather than raw text, reducing tokens and improving
 * consistency. The LLM call disambiguates and scores; this function surfaces
 * candidates cheaply.
 *
 * @param {string} text  Transcript segment text
 * @returns {object}  { persons[], orgs[], topics[], numbers[], hashtags[] }
 */
AI_LLM.extractEntities = function (text) {
	if (!text || typeof text !== 'string') {
		return { persons: [], orgs: [], topics: [], numbers: [], hashtags: [] };
	}

	// Persons: sequences of 2–4 Title Case words, not at sentence start after ".?!"
	// Excludes common false positives (I, A, The, etc.)
	var STOPWORDS = /^(The|A|An|In|On|At|For|Of|And|But|Or|So|To|It|Is|Are|Was|Were|Be|Been|Has|Have|Had|That|This|These|Those|With|From|About|Into|Through|During|Before|After|Above|Below|Between|Each|Few|More|Most|Other|Some|Such|No|Nor|Not|Only|Own|Same|Than|Too|Very|Just|Should|Now|My|Your|His|Her|Our|Their|We|They|He|She|What|Which|Who|Whom|How|When|Where|Why)$/;

	var persons = [];
	var personRe = /\b([A-Z][a-z]{1,20})(?:\s+[A-Z][a-z]{0,20}){1,3}\b/g;
	var m;
	while ((m = personRe.exec(text)) !== null) {
		var candidate = m[0].trim();
		var parts = candidate.split(/\s+/);
		// Require at least one non-stopword part beyond the first
		var meaningful = parts.slice(1).some(function (p) { return !STOPWORDS.test(p); });
		if (meaningful && !persons.includes(candidate)) {
			persons.push(candidate);
		}
	}

	// Orgs: known suffixes / abbreviations or all-caps 2–5 char tokens
	var orgs = [];
	var orgRe = /\b([A-Z][A-Za-z&]{1,30}(?:\s+[A-Z][A-Za-z&]{1,30}){0,3}(?:\s+(?:Inc|Corp|LLC|Ltd|Co|Group|Foundation|Institute|University|College|School|Labs?|Technologies?|Systems?|Solutions?|Services?|Networks?|Capital|Ventures?|Partners?|Fund|AI|API)\.?))\b/g;
	while ((m = orgRe.exec(text)) !== null) {
		var org = m[0].trim();
		if (!orgs.includes(org)) orgs.push(org);
	}
	// All-caps acronyms 2-5 chars (NVIDIA, GPT, LLM, etc.)
	var acronymRe = /\b([A-Z]{2,5})\b/g;
	while ((m = acronymRe.exec(text)) !== null) {
		if (!orgs.includes(m[1])) orgs.push(m[1]);
	}

	// Numbers with units — stat card candidates
	var numbers = [];
	var numRe = /\b(\d[\d,]*(?:\.\d+)?)\s*(billion|million|trillion|thousand|percent|%|x|times|dollars?|\$|euros?|bps|ms|kb|mb|gb|tb)?\b/gi;
	while ((m = numRe.exec(text)) !== null) {
		numbers.push({ value: m[1], unit: (m[2] || '').toLowerCase(), raw: m[0].trim() });
	}

	// Topics: lowercase keyword phrases after indicator words
	var topics = [];
	var topicRe = /(?:about|discuss(?:ing)?|talk(?:ing)?\s+about|regard(?:ing)?|on\s+the\s+topic\s+of|focus(?:ing)?\s+on|mention(?:s|ed|ing)?)\s+([a-z][a-z\s]{3,40}?)(?=[,\.;!?\n]|$)/gi;
	while ((m = topicRe.exec(text)) !== null) {
		var topic = m[1].trim();
		if (topic.split(' ').length <= 5 && !topics.includes(topic)) {
			topics.push(topic);
		}
	}

	// Hashtags (already structured)
	var hashtags = [];
	var hashRe = /#([A-Za-z][A-Za-z0-9_]{1,30})/g;
	while ((m = hashRe.exec(text)) !== null) {
		hashtags.push(m[1]);
	}

	return { persons: persons, orgs: orgs, topics: topics, numbers: numbers, hashtags: hashtags };
};

/**
 * Build Pexels/Pixabay/archive search queries from extracted entities.
 * Returns a priority-ordered array of query strings.
 * No LLM call — pure string operations.
 *
 * @param {object} entities  Output of extractEntities()
 * @param {string} [contextHint]  Optional context (topic of current episode)
 * @returns {string[]}  Query strings, most specific first
 */
AI_LLM.buildSearchQueries = function (entities, contextHint) {
	var queries = [];

	// Person + context → most specific (profile photo context)
	entities.persons.forEach(function (p) {
		if (contextHint) queries.push(p + ' ' + contextHint);
		queries.push(p);
	});

	// Org + AI context
	entities.orgs.forEach(function (o) {
		if (o.length > 2) { // skip bare acronyms alone
			if (contextHint) queries.push(o + ' ' + contextHint);
			else queries.push(o + ' technology');
		}
	});

	// Numbers with units → chart/stat context
	entities.numbers.forEach(function (n) {
		if (n.unit && contextHint) {
			queries.push(contextHint + ' ' + n.unit + ' statistics');
		}
	});

	// Topics directly
	entities.topics.forEach(function (t) {
		queries.push(t);
	});

	// Deduplicate and limit
	var seen = {};
	return queries.filter(function (q) {
		q = q.trim();
		if (!q || seen[q]) return false;
		seen[q] = true;
		return true;
	}).slice(0, 8);
};

/**
 * Look up stream titles matching entity names.
 * Uses Qbix Streams_Avatar::fetchByPrefix pattern via Q.req.
 * Returns matched streams for profile card proposals without an LLM call.
 *
 * @param {string[]} names  Person or org names to look up
 * @param {object}   [options]
 * @param {string}   [options.publisherId]  Scope lookup to a publisher
 * @param {number}   [options.limit=3]
 * @returns {Promise<object[]>}  Array of { publisherId, streamName, title, icon }
 */
AI_LLM.lookupStreams = function (names, options) {
	if (!names || !names.length) return Promise.resolve([]);
	options = options || {};
	var limit = options.limit || 3;
	var results = [];
	var promises = names.slice(0, 5).map(function (name) {
		return new Promise(function (resolve) {
			Q.req('Streams/avatar', ['avatars'], function (err, response) {
				if (err || !response.slots || !response.slots.avatars) return resolve([]);
				resolve(response.slots.avatars || []);
			}, {
				fields: {
					prefix: name,
					limit:  limit,
					communities: false
				}
			});
		});
	});
	return Promise.all(promises).then(function (groups) {
		groups.forEach(function (group) {
			(group || []).forEach(function (avatar) {
				results.push(avatar);
			});
		});
		return results;
	});
};

// ── Observation pipeline ───────────────────────────────────────────────────────

/**
 * Build prompt + schema from observation definitions.
 * Mirrors PHP AI_LLM::promptFromObservations().
 */
AI_LLM.promptFromObservations = function (observations) {
	var clauses = [];
	var schema  = {};
	Object.keys(observations).forEach(function (name) {
		var o = observations[name];
		if (!o.promptClause || !o.fieldNames) return;
		clauses.push('- ' + o.promptClause);
		schema[name] = {};
		o.fieldNames.forEach(function (field) {
			schema[name][field] = (o.example && Object.prototype.hasOwnProperty.call(o.example, field))
				? o.example[field] : null;
		});
	});
	return { clauses: clauses, schema: schema };
};

/**
 * Run observation pipeline — one model call.
 * Mirrors PHP AI_LLM::process().
 * Pass options.webSearch to enable web search on supported adapters.
 */
AI_LLM.prototype.process = function (inputs, observations, interpolate, options) {
	if (!observations || !Object.keys(observations).length) return Promise.resolve({});
	var o = AI_LLM.promptFromObservations(observations);
	if (!o.clauses.length) return Promise.reject(new Error('No valid observation clauses'));
	var prompt =
		'You are an automated semantic processor.\n\n' +
		'Rules:\n' +
		'- Output MUST be valid JSON\n' +
		'- Do not include comments or prose\n' +
		'- Do not omit fields\n' +
		'- Use null when uncertain\n' +
		'- Numeric values must be within stated ranges\n\n' +
		'OBSERVATIONS:\n' + o.clauses.join('\n') + '\n\n' +
		'Return ONLY valid JSON matching this schema:\n' +
		JSON.stringify(o.schema, null, 2);

	if (interpolate && typeof interpolate === 'object') {
		prompt = prompt.replace(/\{\{(\w+)\}\}/g, function (_, k) {
			return Object.prototype.hasOwnProperty.call(interpolate, k) ? interpolate[k] : '';
		});
	}
	return this.executeModel(prompt, inputs, Object.assign({}, options || {}))
		.then(function (raw) {
			var text = typeof raw === 'string' ? raw : ((raw && raw.text) || '');
			text = text.replace(/^```[a-z]*\n?|\n?```$/g, '').trim();
			var data = JSON.parse(text);
			if (typeof data !== 'object' || data === null) throw new Error('Model did not return JSON object');
			return data;
		});
};

/**
 * Summarize text → {title, keywords, summary, speakers}.
 * Mirrors PHP AI_LLM::summarize().
 */
AI_LLM.prototype.summarize = function (text, options) {
	if (!text || !text.trim()) return Promise.resolve({});
	var opts = Object.assign({ temperature: 0, max_tokens: 1000 }, options || {});
	var instructions =
		'Extract structured summaries using XML-style tags.\n\n' +
		'Output exactly:\n' +
		'<title> (under 200 chars)\n' +
		'<keywords> comma-separated, max 400 chars\n' +
		'<summary> one paragraph, max 512 chars\n' +
		'<speakers> comma-separated names OR "no names"\n\n' +
		'No extra text. No markdown. No explanations.\n\nText:\n' + text;

	return this.executeModel(instructions, { text: text }, opts)
		.then(function (raw) {
			var content = typeof raw === 'string' ? raw : ((raw && raw.text) || '');
			content = content.replace(/^```[a-z]*\n?|\n?```$/g, '').trim();
			var extract = function (tag) {
				var m = content.match(new RegExp('<' + tag + '>(.*?)<\\/' + tag + '>', 's'));
				return m ? m[1].trim() : '';
			};
			var kwStr   = extract('keywords');
			var speakers = extract('speakers');
			if (speakers.toLowerCase() === 'no names') speakers = '';
			return {
				title:    extract('title'),
				keywords: kwStr ? kwStr.split(/\s*,\s*/).map(function (k) { return k.toLowerCase(); }) : [],
				summary:  extract('summary'),
				speakers: speakers
			};
		});
};

/**
 * Expand keywords for search indexing.
 * Mirrors PHP AI_LLM::keywords().
 */
AI_LLM.prototype.keywords = function (keywords, during, options) {
	if (!keywords || !keywords.length) return Promise.resolve([]);
	during  = during || 'insert';
	options = options || {};
	var temperature = during === 'query' ? 0.3 : 0.7;
	var language    = options.language || 'en';
	var original    = keywords.join(', ');
	var prompt =
		'Expand canonical search keywords into useful query terms.\n\n' +
		'Input:\n' + original + '\n\n' +
		'Rules: comma-separated, max 1000 terms per line, 1-2 words each, ' +
		'no punctuation except commas, no duplicates, highly relevant only.\n\n' +
		'Output:\nLine 1: English keywords\n' +
		(language && language.toLowerCase() !== 'en' ? 'Line 2: ' + language + ' keywords\n' : '');

	return this.executeModel(prompt, { text: original }, Object.assign({ temperature: temperature, max_tokens: 2000 }, options))
		.then(function (raw) {
			var content = typeof raw === 'string' ? raw : ((raw && raw.text) || '');
			content = content.replace(/^```[a-z]*\n?|\n?```$/g, '').trim();
			var english = (content.split(/\r?\n/)[0] || '').split(/\s*,\s*/)
				.map(function (k) { return k.toLowerCase().trim(); })
				.filter(Boolean);
			return Array.from(new Set(english));
		});
};

/**
 * High-level helper: search the web and return answer text + citations.
 * Uses options.webSearch = true implicitly.
 * Only works if the adapter supportsWebSearch().
 *
 * @param {string} instructions  System prompt / framing
 * @param {string} query         What to search for
 * @param {object} [options]
 * @param {string|object} [options.webSearch]  Web search config (default: true)
 * @param {boolean} [options.includeCitations] Return { text, citations[] } instead of string
 * @returns {Promise<string|{text,citations}>}
 */
AI_LLM.prototype.searchAndRespond = function (instructions, query, options) {
	if (!this.supportsWebSearch()) {
		return Promise.reject(new Error('AI_LLM.searchAndRespond: adapter does not support web search'));
	}
	options = Object.assign({ webSearch: true, max_tokens: 1500 }, options || {});
	return this.executeModel(instructions, { text: query }, options);
};

// ── Stubs (adapters implement) ─────────────────────────────────────────────────

AI_LLM.prototype.executeModel = function () {
	return Promise.reject(new Error('AI_LLM.executeModel: not implemented'));
};

AI_LLM.prototype.supportsPrefixCache = function () { return false; };

// ── Auto-register adapter files ────────────────────────────────────────────────

require('AI/LLM/Openai');
require('AI/LLM/Anthropic');
require('AI/LLM/Google');
require('AI/LLM/Aws');