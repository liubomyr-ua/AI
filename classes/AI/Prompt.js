"use strict";
/**
 * AI/classes/AI/Prompt.js
 *
 * Builds prompts for the LLM pipeline from messages.schema.json.
 *
 * PRIMARY API — buildQueryPrompt(options)
 * Returns { systemPrefix, instructions, executeOptions }.
 *
 *   systemPrefix   — Full static schema, byte-stable across calls (KV cached).
 *   instructions   — Tiny per-call block (role, streamName, contextHint, allow).
 *   executeOptions — { webSearch, max_tokens, response_format, json_schema }
 *                    with response_format set to guarantee JSON output.
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
 * Render ALL visualization types from the schema — always the full set, never
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

// -- JSON schemas for structured output --------------------------------------

/**
 * Loose schema for use with `response_format: 'json_schema'`.
 *
 * Outer structure is enforced (action must be one of four verbs; confidence
 * is a number; etc.). Inner objects (visualizationData, ephemeralPayload)
 * are strings that the LLM emits as JSON-encoded content. Downstream parsing
 * is responsible for JSON.parse'ing those inner strings.
 *
 * Why strings for inner objects: OpenAI's strict mode requires enumerating
 * every property with additionalProperties:false. visualizationData varies
 * per visualizationType (glossary has term/definition, barChart has items[],
 * slide has html/buildAuto). Enumerating a superset for every viz type is
 * impractical and creates maintenance overhead. Using strings preserves
 * flexibility while getting outer structure guarantees.
 *
 * Callers wanting stricter inner schemas can override via options.jsonSchema.
 *
 * @private
 * @return {Object} JSON Schema
 */
function _buildResponseSchema() {

    return {

        type: 'object',
        additionalProperties: false,
        required: [
            'action', 'confidence', 'routing',
            'visualizationType', 'visualizationData',
            'ephemeralType', 'ephemeralPayload',
            'coachingText', 'sourceUri'
        ],
        properties: {

            action: {
                type: 'string',
                enum: ['propose', 'ephemeral', 'coaching', 'none'],
                description:
                    'MUST be one of the four verbs. Never a visualization type.'
            },

            confidence: {
                type: 'number',
                description: '0.0 to 1.0. Below 0.7 use "none" instead.'
            },

            routing: {
                type: ['string', 'null'],
                enum: ['shared', 'privateOnly', null]
            },

            visualizationType: {
                type: ['string', 'null'],
                description:
                    'Only when action="propose". Type name from the schema list.'
            },

            visualizationData: {
                type: ['object', 'null'],
                additionalProperties: true,
                description:
                    'Only when action="propose". A JSON OBJECT (not a string) ' +
                    'containing the fields defined for the chosen visualizationType.'
            },

            ephemeralType: {
                type: ['string', 'null'],
                description:
                    'Only when action="ephemeral". Type of control ephemeral.'
            },

            ephemeralPayload: {
                type: ['object', 'null'],
                additionalProperties: true,
                description:
                    'Only when action="ephemeral". A JSON OBJECT (not a string) ' +
                    'matching the payload fields for the chosen ephemeralType.'
            },

            coachingText: {
                type: ['string', 'null'],
                description: 'Only when action="coaching". Message shown to host only.'
            },

            sourceUri: {
                type: ['string', 'null'],
                description: 'Optional source URL when relevant.'
            }
        }
    };
}
// -- Cached prefix (built once, reused every call) ---------------------------

var _cachedPrefix    = null;
var _cachedPrefixMtm = 0;

/**
 * Build (or return cached) the full static system prefix.
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
        'Respond with ONE JSON object only -- no markdown fences, no preamble.',
        '',
        'The "action" field is ALWAYS exactly one of these four verbs:',
        '  - "propose"   -> suggest a visualization to display on the shared screen',
        '  - "ephemeral" -> fire a control event directly (no veto)',
        '  - "coaching"  -> private hint shown only to the host',
        '  - "none"      -> nothing to show',
        '',
        'NEVER put a visualization type (like "glossary", "stat", "comparison") in the',
        '"action" field. Those go inside "visualizationType". See examples below.',
        '',
        'Schema:',
        '{',
        '  "action": "propose" | "ephemeral" | "coaching" | "none",',
        '  "confidence": 0.0-1.0,',
        '  "routing": "shared" | "privateOnly" | null,',
        '',
        '  // when action = "propose"',
        '  "visualizationType": "<type from list below>" | null,',
        '  "visualizationData": { ...fields for the chosen type... } | null,',
        '',
        '  // when action = "ephemeral"',
        '  "ephemeralType": "..." | null,',
        '  "ephemeralPayload": { ...fields for the chosen type... } | null,',
        '',
        '  // when action = "coaching"',
        '  "coachingText": "..." | null,',
        '  "sourceUri": "https://..." | null',
        '}',
        '',
        'Set unused fields to null. All fields must be present.',
        'confidence < 0.7 -> use "none". Prefer "none" over a weak proposal.',
        'routing "privateOnly" -> host sees it, shared screen does not.',
        '',
        '---',
        '',
        '## CORRECT EXAMPLE',
        '{',
        '  "action": "propose",',
        '  "confidence": 0.95,',
        '  "routing": "shared",',
        '  "visualizationType": "glossary",',
        '  "visualizationData": {"term":"Generative AI","definition":"AI systems that create new content","context":"Used for text, images, music, code generation."},',
        '  "ephemeralType": null,',
        '  "ephemeralPayload": null,',
        '  "coachingText": null,',
        '  "sourceUri": null',
        '}',
        '',
        '## INCORRECT EXAMPLES -- DO NOT RESPOND LIKE THESE',
        '',
        '// Wrong: action is a visualization type',
        '{ "action": "glossary", "term": "..." }',
        '',
        '// Wrong: visualizationData as a JSON-encoded string instead of a raw object',
        '{ "action": "propose", "visualizationData": "{\"term\":\"...\"}" }',
        '',
        '// Wrong: missing null fields',
        '{ "action": "propose", "visualizationType": "glossary", "visualizationData": {"term":"..."} }',
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
        'person photos), include the image URL directly inside visualizationData:',
        '- Cards (stat, profile, article, quote): add "imageUrl" and "imageCredit"',
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
        '6. Respond ONLY with the JSON object.',
        '',
        '## REMINDER',
        '"action" is always exactly one of: propose, ephemeral, coaching, none.',
        '"visualizationData" and "ephemeralPayload" are plain JSON objects, never strings.',
        'Every field must be present (set unused ones to null).',
        'Re-read the CORRECT EXAMPLE above before responding.'
    ].join('\n').trim();

    _cachedPrefixMtm = _schemaMtm;
    return _cachedPrefix;
}

// -- Per-call dynamic instructions -------------------------------------------

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
 *   @param {String}       [options.role='host']
 *   @param {String}       [options.publisherId]
 *   @param {String}       [options.streamName]
 *   @param {String}       [options.contextHint]     One-sentence context
 *   @param {String|Array} [options.allow='any']     Type constraint
 *   @param {Boolean}      [options.webSearch=true]
 *   @param {Number}       [options.maxTokens=2048]
 *   @param {String}       [options.responseFormat]  Override: 'json' | 'json_schema'
 *                                                   Default: 'json_schema' with the
 *                                                   built-in loose schema (outer
 *                                                   structure enforced, inner data
 *                                                   as JSON strings).
 *   @param {Object}       [options.jsonSchema]      Override the built-in schema
 *                                                   when responseFormat='json_schema'.
 * @return {Object} { systemPrefix, instructions, executeOptions }
 */
function buildQueryPrompt(options) {
    options = options || {};

    // Default: strict json_schema with the outer-structure schema.
    // Callers can pass responseFormat: 'json' for lighter enforcement
    // (guaranteed valid JSON without structural rules), or provide their
    // own jsonSchema to enforce inner fields.
    var responseFormat = options.responseFormat || 'json_schema';
    var jsonSchema     = options.jsonSchema     || _buildResponseSchema();

    var executeOptions = {
        webSearch:  options.webSearch !== false,
        max_tokens: options.maxTokens || 2048
    };

    if (responseFormat === 'json_schema') {
        executeOptions.response_format = 'json_schema';
        executeOptions.json_schema     = jsonSchema;
        executeOptions.schema_name     = options.schemaName || 'ai_pipeline_response';
    } else if (responseFormat === 'json') {
        executeOptions.response_format = 'json';
    }
    // 'none' or any other value -> no structured output enforcement.

    return {
        systemPrefix:   _buildStaticPrefix(),
        instructions:   _buildInstructions(options),
        executeOptions: executeOptions
    };
}

/**
 * Legacy alias — returns just a systemPrompt string for backward compat.
 * @method buildSystemPrompt
 * @static
 */
function buildSystemPrompt(options) {
    var parts = buildQueryPrompt(options);
    return parts.systemPrefix + (parts.instructions ? '\n\n' + parts.instructions : '');
}

function getSchemaCacheKey() {
    _loadSchema();
    return 'ai-pipeline-schema-v' + Math.floor(_schemaMtm / 1000);
}

function getSchema()    { return _loadSchema(); }
function reloadSchema() { _schema = null; _cachedPrefix = null; return _loadSchema(); }

module.exports = {
    buildQueryPrompt:    buildQueryPrompt,
    buildSystemPrompt:   buildSystemPrompt,
    getSchemaCacheKey:   getSchemaCacheKey,
    getSchema:           getSchema,
    reloadSchema:        reloadSchema,
    CATEGORIES:          CATEGORIES,
    // Exposed so callers can inspect the schema or use it in tests
    _buildResponseSchema: _buildResponseSchema
};