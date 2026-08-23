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

var Q         = require('Q');
var fs        = require('fs');
var path      = require('path');
var Tokenizer = require('./Tokenizer');

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

/**
 * Render the contextSummary field definitions + example from the schema into
 * prompt text for the "ROLLING CONTEXT SUMMARY" section of the static prefix.
 */
function _renderContextSummarySchema(schema) {
    var cs = schema.contextSummary || {};
    var lines = [];
    if (cs.instructions) lines.push(cs.instructions);
    var fields = cs.fields || {};
    lines.push('');
    lines.push('Fields:');
    Object.keys(fields).forEach(function (fn) {
        var spec = fields[fn];
        lines.push('  ' + fn + ' (' + (spec.type || 'string') + ', required): ' +
            (spec.description || ''));
    });
    if (cs.example != null) {
        lines.push('');
        lines.push('Example:');
        lines.push(JSON.stringify(cs.example, null, 2));
    }
    return lines.join('\n');
}

// -- Rolling context summary ("older context") --------------------------------

/**
 * Render the previous contextSummary object (or null on the first call of a
 * session) into the "OLDER CONTEXT" block placed in the per-call instructions.
 * Exported so callers doing token-budget math (TranscriptBuffer) can measure
 * the exact text that will be sent, rather than approximating it.
 *
 * @method renderOlderContext
 * @static
 * @param {Object|null} summary  A contextSummary object, or null/undefined.
 * @return {String}
 */
function renderOlderContext(summary) {
    if (!summary || typeof summary !== 'object' ||
        (!(summary.key_entities || []).length &&
         !(summary.topic_timeline || []).length &&
         !summary.running_narrative)) {
        return 'OLDER CONTEXT: (none yet -- this is the start of the talk.)';
    }
    var lines = ['OLDER CONTEXT (carry forward; update only what the transcript below changed):'];
    if (summary.key_entities && summary.key_entities.length) {
        lines.push('Key entities:');
        summary.key_entities.forEach(function (e) { lines.push('- ' + e); });
    }
    if (summary.topic_timeline && summary.topic_timeline.length) {
        lines.push('Topic timeline:');
        summary.topic_timeline.forEach(function (t) { lines.push('- ' + t); });
    }
    if (summary.running_narrative) {
        lines.push('Narrative: ' + summary.running_narrative);
    }
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
            'coachingText', 'sourceUri', 'contextSummary'
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
            },

            contextSummary: {
                type: 'object',
                additionalProperties: false,
                required: ['key_entities', 'topic_timeline', 'running_narrative'],
                description:
                    'ALWAYS present, every turn, regardless of action. Rigid ' +
                    '(non-freeform) structure to avoid compression loss across ' +
                    'repeated re-summarization -- see ROLLING CONTEXT SUMMARY.',
                properties: {
                    key_entities: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Immutable hard facts, carried forward unchanged unless superseded.'
                    },
                    topic_timeline: {
                        type: 'array',
                        items: { type: 'string' },
                        description: '"HH:MM - topic" log, append-only, current entry marked [CURRENT].'
                    },
                    running_narrative: {
                        type: 'string',
                        description: 'Third-person prose arc of the talk so far, under 250 words.'
                    }
                }
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
    var summaryText = _renderContextSummarySchema(schema);

    _cachedPrefix = [
        'You are an AI assistant for a live presentation.',
        '',
        '## HOW YOUR INPUT IS STRUCTURED',
        'Each turn you receive three things:',
        '  1. This fixed system prompt (unchanging across the whole talk).',
        '  2. An OLDER CONTEXT block -- the rolling summary of everything said',
        '     before the transcript below (see ROLLING CONTEXT SUMMARY). Empty on',
        '     the first turn of a session.',
        '  3. A REAL-TIME TRANSCRIPT -- the user message: the most recent raw',
        '     speech, chunked. It typically overlaps with transcript text you',
        '     already saw last turn, so you can track continuity without a full',
        '     re-read.',
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
        'WAKE-WORD REQUESTS: if the REAL-TIME TRANSCRIPT (the user message) starts',
        'with "Safebots," the speaker explicitly invoked you by name and is asking',
        'for something to be shown -- this is a direct command, not passive',
        'narration. Such a request MUST use action "propose" (or "ephemeral" if it',
        'is a control command like "next slide"). NEVER answer a "Safebots," request',
        'with "coaching" or "none" -- the host asked out loud for a visible result,',
        'so a private-only or empty response fails the request. If you are unsure',
        'exactly what to show, still propose your best-effort visualization rather',
        'than falling back to coaching or none.',
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
        '  "sourceUri": "https://..." | null,',
        '',
        '  // ALWAYS included, every turn, regardless of "action" -- see',
        '  // ROLLING CONTEXT SUMMARY below',
        '  "contextSummary": { "key_entities": [...], "topic_timeline": [...], "running_narrative": "..." }',
        '}',
        '',
        'Set unused action-specific fields to null. contextSummary is never null.',
        'All fields must be present.',
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
        '  "sourceUri": null,',
        '  "contextSummary": {',
        '    "key_entities": ["Topic: Generative AI"],',
        '    "topic_timeline": ["00:00 - Introduction to generative AI [CURRENT]"],',
        '    "running_narrative": "The speaker introduced generative AI and defined the term for the audience."',
        '  }',
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
        '## ROLLING CONTEXT SUMMARY',
        'The OLDER CONTEXT block you receive each turn (above the real-time',
        'transcript) is the "contextSummary" you returned last turn. This is how',
        'you stay coherent across a multi-hour talk without re-reading the whole',
        'transcript every call -- treat it as your own memory, not new speaker input.',
        summaryText,
        '',
        'Structure, don\'t narrate: key_entities and topic_timeline are append-only',
        'logs (rewrite an entry only when the transcript explicitly supersedes it);',
        'running_narrative is the one field you may reword each turn.',
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
        '7. Always populate contextSummary fully and accurately, every turn --',
        '   including on "none" turns. It is your only memory of the talk so far.',
        '8. Transcript starts with "Safebots," -> action MUST be "propose" or',
        '   "ephemeral". Never "coaching" or "none" for a direct wake-word request.',
        '',
        '## REMINDER',
        '"action" is always exactly one of: propose, ephemeral, coaching, none.',
        '"visualizationData" and "ephemeralPayload" are plain JSON objects, never strings.',
        'Every field must be present (set unused ones to null; contextSummary is never null).',
        'Transcript starts with "Safebots," -> "propose" or "ephemeral", never "coaching"/"none".',
        'Re-read the CORRECT EXAMPLE above before responding.'
    ].join('\n').trim();

    _cachedPrefixMtm = _schemaMtm;
    return _cachedPrefix;
}

// -- Token counting ------------------------------------------------------------

var _cachedPrefixTokens    = null;
var _cachedPrefixTokensMtm = 0;

/**
 * Token count of the static system prefix, cached until the schema file
 * changes. Used by TranscriptBuffer to budget how much of the real-time
 * transcript window fits under a total input-token cap.
 *
 * @method getStaticPrefixTokenCount
 * @static
 * @return {Number}
 */
function getStaticPrefixTokenCount() {
    var prefix = _buildStaticPrefix();
    if (_cachedPrefixTokens != null && _cachedPrefixTokensMtm === _schemaMtm) {
        return _cachedPrefixTokens;
    }
    _cachedPrefixTokens    = Tokenizer.estimateTokens(prefix);
    _cachedPrefixTokensMtm = _schemaMtm;
    return _cachedPrefixTokens;
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

    // "Older Context" — the rolling summary from the previous turn. Lives in
    // the per-call (uncached) instructions block, not the static prefix,
    // since it changes every turn. See renderOlderContext().
    lines.push('');
    lines.push(renderOlderContext(options.contextSummary));

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
 *   @param {Object}       [options.contextSummary]  Previous turn's rolling
 *                                                   summary (contextSummary
 *                                                   field of the last response),
 *                                                   rendered as the "Older
 *                                                   Context" block. Omit/null
 *                                                   on the first turn.
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
function reloadSchema() {
    _schema = null;
    _cachedPrefix = null;
    _cachedPrefixTokens = null;
    return _loadSchema();
}

module.exports = {
    buildQueryPrompt:          buildQueryPrompt,
    buildSystemPrompt:         buildSystemPrompt,
    getSchemaCacheKey:         getSchemaCacheKey,
    getSchema:                 getSchema,
    reloadSchema:              reloadSchema,
    CATEGORIES:                CATEGORIES,
    // Rolling context summary + token budgeting — used directly by
    // AI/classes/AI/TranscriptBuffer.js so its budget math matches exactly
    // what buildQueryPrompt() will actually send.
    renderOlderContext:        renderOlderContext,
    estimateTokens:            Tokenizer.estimateTokens,
    getStaticPrefixTokenCount: getStaticPrefixTokenCount,
    // Exposed so callers can inspect the schema or use it in tests
    _buildResponseSchema: _buildResponseSchema
};