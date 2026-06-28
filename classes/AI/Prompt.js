"use strict";
/**
 * AI/classes/AI/Prompt.js
 *
 * Builds prompts for the LLM pipeline from messages.schema.json.
 *
 * PRIMARY API -- buildQueryPrompt(options)
 * Returns { systemPrefix, instructions, executeOptions }.
 *
 *   systemPrefix   -- The full static schema: ALL viz types, image rules, rules.
 *                     ~2900 tokens, byte-stable across calls. Goes into the KV
 *                     cache (Anthropic: cache_control ephemeral). OpenAI caches
 *                     this automatically (>1024 tokens, no annotation needed).
 *   instructions   -- Tiny dynamic part: role + publisherId + streamName +
 *                     contextHint + allow constraint. ~20-60 tokens, NOT cached.
 *   executeOptions -- { webSearch, max_tokens } for the adapter.
 *
 * Slicing the schema per call would change the bytes every call and miss the
 * cache; instead systemPrefix is the FULL unsliced schema (stable bytes -> hit)
 * and the allow-constraint sentence in `instructions` narrows the output.
 *
 * LEGACY API
 *   buildSystemPrompt(options) -> string   (backward compat)
 *
 * @module AI
 * @class Prompt
 * @static
 */

var Q    = require('Q');
var fs   = require('fs');
var path = require('path');

// -- Schema loading ----------------------------------------------------------

var _schema    = null;
var _schemaMtm = 0;

function _loadSchema() {
    if (_schema) return _schema;

    var candidates = [
        Q.pluginDir('AI', 'CONFIG')
            ? path.join(Q.pluginDir('AI', 'CONFIG'), 'messages.schema.json')
            : null,
        path.join(__dirname, '../../..', 'AI', 'config', 'messages.schema.json'),
    ].filter(Boolean);

    for (var i = 0; i < candidates.length; i++) {
        try {
            _schema    = JSON.parse(fs.readFileSync(candidates[i], 'utf8'));
            _schemaMtm = fs.statSync(candidates[i]).mtimeMs;
            return _schema;
        } catch (e) {}
    }
    Q.log && Q.log('AI.Prompt: messages.schema.json not found in: ' + candidates.join(', '));
    _schema = {};
    return _schema;
}

// -- Type categories (exported for callers) ----------------------------------

var CATEGORIES = {
    cards:  ['stat', 'glossary', 'quote', 'profile', 'article', 'comparison'],
    charts: ['barChart', 'lineChart', 'graph', 'table'],
    rich:   ['stat', 'glossary', 'quote', 'profile', 'article', 'comparison',
             'barChart', 'lineChart', 'graph', 'table', 'slide'],
    any:    null  // null -> all types from schema
};

function _resolveAllowed(allow, schema) {
    var all = Object.keys(schema.visualizationTypes || {}).filter(function (k) {
        return k.charAt(0) !== '_';
    });
    if (!allow || allow === 'any') return all;
    var candidates = (typeof allow === 'string')
        ? (CATEGORIES[allow] || all)
        : (Array.isArray(allow) ? allow : all);
    return candidates.filter(function (t) { return all.indexOf(t) !== -1; });
}

// -- Static prefix renderers -------------------------------------------------

/**
 * Render ALL visualization types from the schema -- always the full set, never
 * sliced, so the bytes are stable for the KV cache.
 */
function _renderAllVizTypes(schema) {
    var types = schema.visualizationTypes || {};
    var lines = [];
    Object.keys(types).forEach(function (name) {
        if (name.charAt(0) === '_') return;
        var def = types[name];
        lines.push('\n### ' + name);
        if (def.description) lines.push(def.description);
        var fields = def.fields || {};
        var flines = [];
        Object.keys(fields).forEach(function (fn) {
            var spec = fields[fn];
            var req = spec.required ? '(required)' : '(optional)';
            flines.push('  ' + fn + ' ' + req + ': ' + (spec.type || 'string') +
                ' -- ' + (spec.description || ''));
        });
        if (flines.length) {
            lines.push('Fields:');
            lines = lines.concat(flines);
        }
        if (def.example != null) {
            lines.push('Example:');
            lines.push('  ' + JSON.stringify(def.example, null, 2).split('\n').join('\n  '));
        }
    });
    return lines.join('\n');
}

/**
 * Render ALL control ephemerals. Always the full set for byte-stability.
 */
function _renderAllEphemerals(schema) {
    var ephemerals = schema.ephemerals || {};
    var SKIP = { 'Media/presentation/show': true };
    var lines = [];
    Object.keys(ephemerals).forEach(function (type) {
        if (SKIP[type]) return;
        var def = ephemerals[type];
        lines.push('\n**' + type + '**');
        if (def.description) lines.push(def.description);
        if (def.payload && Object.keys(def.payload).length) {
            lines.push('Payload: ' + JSON.stringify(def.payload));
        } else if (def.payloadVariants) {
            def.payloadVariants.forEach(function (v, i) {
                lines.push('Variant ' + (i + 1) + ' (' + v.description + '): ' +
                    JSON.stringify(v.example));
            });
        } else {
            lines.push('Payload: {}');
        }
    });
    return lines.join('\n');
}

// -- Cached prefix (built once, reused every call) ---------------------------

var _cachedPrefix    = null;
var _cachedPrefixMtm = 0;

/**
 * Build (or return cached) the full static system prefix. Byte-stable: same
 * schema -> same bytes -> KV cache always hits. ~2900 tokens.
 */
function _buildStaticPrefix() {
    var schema = _loadSchema();
    if (_cachedPrefix && _cachedPrefixMtm === _schemaMtm) return _cachedPrefix;

    var vizText = _renderAllVizTypes(schema);
    var ephText = _renderAllEphemerals(schema);

    _cachedPrefix = [
        'You are an AI assistant for a live presentation.',
        '',
        '## OUTPUT FORMAT',
        'Respond with ONE JSON object only -- no markdown fences, no preamble:',
        '{',
        '  "action": "propose" | "ephemeral" | "coaching" | "none",',
        '  "confidence": 0.0-1.0,',
        '  "routing": "shared" | "privateOnly",',
        '',
        '  // action = "propose" -- show a visualization on the shared screen',
        '  "visualizationType": "<type from list below>",',
        '  "visualizationData": { /* fields for that type */ },',
        '',
        '  // action = "ephemeral" -- fire a control event directly',
        '  "ephemeralType": "...",',
        '  "ephemeralPayload": {},',
        '',
        '  // action = "coaching" -- private hint to host only',
        '  "coachingText": "...",',
        '  "sourceUri": "https://...",',
        '',
        '  // action = "none" -- nothing to show',
        '}',
        '',
        'confidence < 0.7 -> use "none". Prefer "none" over a weak proposal.',
        'routing "privateOnly" -> host sees it, shared screen does not.',
        '',
        '---',
        '',
        '## ALL VISUALIZATION TYPES',
        vizText,
        '',
        '---',
        '',
        '## CONTROL EPHEMERALS',
        'Only emit these when the speaker explicitly requests a control action.',
        ephText,
        '',
        '---',
        '',
        '## IMAGES FROM WEB SEARCH',
        'When web search returns pages with images (Wikipedia infoboxes, news thumbnails,',
        'person photos), include the image URL directly in your output:',
        '- Cards (stat, profile, article, quote): add "imageUrl": "<url>", "imageCredit": "<domain>"',
        '- Comparison: add "leftImageUrl" and "rightImageUrl"',
        '- Slide: embed images as <img src="<url>" onerror="this.style.display=\'none\'">',
        '- Only include imageUrl when you find a real direct image URL on a searched page.',
        '- imageCredit should be the source domain or publication name.',
        '- Never invent image URLs.',
        '',
        '---',
        '',
        '## RULES',
        '1. Never invent statistics. Only state what the speaker said or web search confirms.',
        '2. Map proposals require confirmed coordinates -- never expose private locations.',
        '3. Keep visualizationData concise -- it becomes stream attributes visible to all participants.',
        '4. For slide: write HTML + inline <style> scoped to .Media_presentation_slide_tool.',
        '   Use data-build="N" data-build-effect="rise|dissolve|slideLeft|slideRight|scale".',
        '   Set buildAuto:true and buildStagger:500 for automatic timed sequence.',
        '5. "Next slide", "scroll down", "pause" etc. -> ephemeral, not proposal.',
        '6. Respond ONLY with the JSON object.'
    ].join('\n').trim();

    _cachedPrefixMtm = _schemaMtm;
    return _cachedPrefix;
}

// -- Per-call dynamic instructions -------------------------------------------

/**
 * Build the tiny per-call instructions block. ~20-60 tokens. NOT cached.
 */
function _buildInstructions(options) {
    var role        = options.role        || 'host';
    var publisherId = options.publisherId || '';
    var streamName  = options.streamName  || '';
    var contextHint = options.contextHint || null;
    var schema      = _loadSchema();

    var lines = [
        'Role: ' + role + '. Stream: publisherId="' + publisherId +
            '", streamName="' + streamName + '".'
    ];

    if (options.allow && options.allow !== 'any') {
        var allowed = _resolveAllowed(options.allow, schema);
        if (allowed.length) {
            lines.push('For this response, only use these visualization types: ' +
                allowed.join(', ') + '.');
        }
    }

    if (contextHint) {
        lines.push('Context: ' + contextHint);
    }

    return lines.join('\n');
}

// -- Public API --------------------------------------------------------------

/**
 * Build prompt parts + execute options for a single LLM call.
 *
 * @method buildQueryPrompt
 * @static
 * @param {Object} options
 *   @param {String}          [options.role='host']
 *   @param {String}          [options.publisherId]
 *   @param {String}          [options.streamName]
 *   @param {String}          [options.contextHint]   One-sentence context
 *   @param {String|Array}    [options.allow='any']   Type constraint
 *   @param {Boolean}         [options.webSearch=true]
 *   @param {Number}          [options.maxTokens=2048]
 * @return {Object} { systemPrefix, instructions, executeOptions }
 */
function buildQueryPrompt(options) {
    options = options || {};
    return {
        systemPrefix:   _buildStaticPrefix(),
        instructions:   _buildInstructions(options),
        executeOptions: {
            webSearch:  options.webSearch !== false,
            max_tokens: options.maxTokens || 2048
        }
    };
}

/**
 * Legacy alias -- returns just a systemPrompt string for backward compat.
 * @method buildSystemPrompt
 * @static
 */
function buildSystemPrompt(options) {
    var parts = buildQueryPrompt(options);
    return parts.systemPrefix + (parts.instructions ? '\n\n' + parts.instructions : '');
}

/**
 * Cache key for the current schema version. Use as the cacheKey argument to
 * adapter.executeWithCachedPrefix(). Changes when the schema file is modified.
 * @method getSchemaCacheKey
 * @static
 */
function getSchemaCacheKey() {
    _loadSchema();
    return 'ai-pipeline-schema-v' + Math.floor(_schemaMtm / 1000);
}

function getSchema()    { return _loadSchema(); }
function reloadSchema() { _schema = null; _cachedPrefix = null; return _loadSchema(); }

module.exports = {
    buildQueryPrompt:  buildQueryPrompt,
    buildSystemPrompt: buildSystemPrompt,
    getSchemaCacheKey: getSchemaCacheKey,
    getSchema:         getSchema,
    reloadSchema:      reloadSchema,
    CATEGORIES:        CATEGORIES
};