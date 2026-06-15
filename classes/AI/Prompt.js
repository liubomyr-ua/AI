'use strict';
/**
 * AI/classes/AI/Prompt.js
 *
 * Builds prompts for the LLM pipeline from messages.schema.json.
 *
 * PRIMARY API — buildQueryPrompt(options)
 * ───────────────────────────────────────
 * Returns { systemPrefix, instructions, executeOptions }.
 *
 *   systemPrefix   — The full static schema: ALL viz types, image rules, rules.
 *                    ~2900 tokens, byte-stable across calls.
 *                    Goes into the KV cache (Anthropic: cache_control: ephemeral).
 *                    OpenAI caches this automatically (>1024 tokens, no annotation needed).
 *
 *   instructions   — Tiny dynamic part: role + publisherId + streamName +
 *                    contextHint + allow constraint sentence.
 *                    ~20-60 tokens, changes every call.
 *                    NOT cached — sent as second uncached system block on Anthropic,
 *                    prepended to the user message on OpenAI.
 *
 *   executeOptions — { webSearch, max_tokens } for the adapter.
 *
 * WHY NOT SLICE THE SCHEMA PER CALL
 * ──────────────────────────────────
 * Slicing (sending only the allowed types) changes the byte content every call,
 * causing a cache miss every time. The cache hit is worth far more than the
 * marginal savings from a shorter prompt. Instead:
 *   - systemPrefix is the FULL unsliced schema (always the same bytes → always a hit)
 *   - instructions constrains the output with one sentence: "Only use: profile, article"
 *
 * CALL PATTERN IN PIPELINE.JS
 * ────────────────────────────
 * If adapter.supportsPrefixCache():
 *   adapter.executeWithCachedPrefix('ai-pipeline-schema-v1', systemPrefix, inputs, {
 *     additionalInstructions: instructions,
 *     ...executeOptions
 *   })
 * Else (OpenAI — auto-caches the prefix internally):
 *   adapter.executeModel(systemPrefix + '\n\n' + instructions, inputs, executeOptions)
 *
 * LEGACY API
 * ──────────
 * buildSystemPrompt(options) → string   (backward compat, used by old call sites)
 *
 * @module AI
 */

const fs   = require('fs');
const path = require('path');

// ── Schema loading ────────────────────────────────────────────────────────────

let _schema    = null;
let _schemaMtm = 0;

function _loadSchema() {
    if (_schema) return _schema;

    const candidates = [
        path.join(__dirname, '../../..', 'Media', 'config', 'messages.schema.json'),
        process.env.MEDIA_PLUGIN_CONFIG_DIR
            ? path.join(process.env.MEDIA_PLUGIN_CONFIG_DIR, 'messages.schema.json')
            : null,
        path.join(__dirname, '../../data', 'messages.schema.json'),
    ].filter(Boolean);

    for (const c of candidates) {
        try {
            _schema    = JSON.parse(fs.readFileSync(c, 'utf8'));
            _schemaMtm = fs.statSync(c).mtimeMs;
            return _schema;
        } catch (e) {}
    }
    _schema = {};
    return _schema;
}

// ── Type categories (exported for callers) ───────────────────────────────────

const CATEGORIES = {
    cards:  ['stat', 'glossary', 'quote', 'profile', 'article', 'comparison'],
    charts: ['barChart', 'lineChart', 'graph', 'table'],
    rich:   ['stat', 'glossary', 'quote', 'profile', 'article', 'comparison',
             'barChart', 'lineChart', 'graph', 'table', 'slide'],
    any:    null,  // null → all types from schema
};

function _resolveAllowed(allow, schema) {
    const all = Object.keys(schema.visualizationTypes || {}).filter(k => !k.startsWith('_'));
    if (!allow || allow === 'any') return all;
    const candidates = (typeof allow === 'string')
        ? (CATEGORIES[allow] || all)
        : (Array.isArray(allow) ? allow : all);
    return candidates.filter(t => all.includes(t));
}

// ── Static prefix renderers ───────────────────────────────────────────────────

/**
 * Render ALL visualization types from the schema.
 * This is always the full set — never sliced — so the bytes are stable.
 */
function _renderAllVizTypes(schema) {
    const types = schema.visualizationTypes || {};
    const lines = [];
    for (const [name, def] of Object.entries(types)) {
        if (name.startsWith('_')) continue;
        lines.push(`\n### ${name}`);
        if (def.description) lines.push(def.description);
        const fields = def.fields || {};
        const flines = [];
        for (const [fn, spec] of Object.entries(fields)) {
            const req = spec.required ? '(required)' : '(optional)';
            flines.push(`  ${fn} ${req}: ${spec.type || 'string'} — ${spec.description || ''}`);
        }
        if (flines.length) { lines.push('Fields:'); lines.push(...flines); }
        if (def.example != null) {
            lines.push('Example:');
            lines.push('  ' + JSON.stringify(def.example, null, 2).split('\n').join('\n  '));
        }
    }
    return lines.join('\n');
}

/**
 * Render ALL control ephemerals — navigation, gallery, style.
 * Always the full set for byte-stability.
 */
function _renderAllEphemerals(schema) {
    const ephemerals = schema.ephemerals || {};
    const SKIP = new Set(['Media/presentation/show']);
    const lines = [];
    for (const [type, def] of Object.entries(ephemerals)) {
        if (SKIP.has(type)) continue;
        lines.push(`\n**${type}**`);
        if (def.description) lines.push(def.description);
        if (def.payload && Object.keys(def.payload).length) {
            lines.push('Payload: ' + JSON.stringify(def.payload));
        } else if (def.payloadVariants) {
            def.payloadVariants.forEach((v, i) =>
                lines.push(`Variant ${i+1} (${v.description}): ${JSON.stringify(v.example)}`));
        } else {
            lines.push('Payload: {}');
        }
    }
    return lines.join('\n');
}

// ── Cached prefix (built once, reused every call) ─────────────────────────────

let _cachedPrefix    = null;
let _cachedPrefixMtm = 0;

/**
 * Build (or return cached) the full static system prefix.
 * Byte-stable: same schema → same bytes → KV cache always hits.
 * ~2900 tokens.
 */
function _buildStaticPrefix() {
    const schema = _loadSchema();
    // Rebuild if schema was reloaded
    if (_cachedPrefix && _cachedPrefixMtm === _schemaMtm) return _cachedPrefix;

    const vizText = _renderAllVizTypes(schema);
    const ephText = _renderAllEphemerals(schema);

    _cachedPrefix = [
        'You are an AI assistant for a live presentation.',
        '',
        '## OUTPUT FORMAT',
        'Respond with ONE JSON object only — no markdown fences, no preamble:',
        '{',
        '  "action": "propose" | "ephemeral" | "coaching" | "none",',
        '  "confidence": 0.0-1.0,',
        '  "routing": "shared" | "privateOnly",',
        '',
        '  // action = "propose" — show a visualization on the shared screen',
        '  "visualizationType": "<type from list below>",',
        '  "visualizationData": { /* fields for that type */ },',
        '',
        '  // action = "ephemeral" — fire a control event directly',
        '  "ephemeralType": "...",',
        '  "ephemeralPayload": {},',
        '',
        '  // action = "coaching" — private hint to host only',
        '  "coachingText": "...",',
        '  "sourceUri": "https://...",',
        '',
        '  // action = "none" — nothing to show',
        '}',
        '',
        'confidence < 0.7 → use "none". Prefer "none" over a weak proposal.',
        'routing "privateOnly" → host sees it, shared screen does not.',
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
        '2. Map proposals require confirmed coordinates — never expose private locations.',
        '3. Keep visualizationData concise — it becomes stream attributes visible to all participants.',
        '4. For slide: write HTML + inline <style> scoped to .Media_presentation_slide_tool.',
        '   Use data-build="N" data-build-effect="rise|dissolve|slideLeft|slideRight|scale".',
        '   Set buildAuto:true and buildStagger:500 for automatic timed sequence.',
        '5. "Next slide", "scroll down", "pause" etc. → ephemeral, not proposal.',
        '6. Respond ONLY with the JSON object.',
    ].join('\n').trim();

    _cachedPrefixMtm = _schemaMtm;
    return _cachedPrefix;
}

// ── Per-call dynamic instructions ─────────────────────────────────────────────

/**
 * Build the tiny per-call instructions block.
 * ~20-60 tokens. Changes every call with role/stream/context/constraint.
 * NOT cached.
 */
function _buildInstructions(options) {
    const role        = options.role        || 'host';
    const publisherId = options.publisherId || '';
    const streamName  = options.streamName  || '';
    const contextHint = options.contextHint || null;
    const schema      = _loadSchema();

    const lines = [
        `Role: ${role}. Stream: publisherId="${publisherId}", streamName="${streamName}".`,
    ];

    // Allow constraint — one short sentence
    if (options.allow && options.allow !== 'any') {
        const allowed = _resolveAllowed(options.allow, schema);
        if (allowed.length) {
            lines.push(`For this response, only use these visualization types: ${allowed.join(', ')}.`);
        }
    }

    // Context hint — one sentence about what the speaker just said/asked
    if (contextHint) {
        lines.push(`Context: ${contextHint}`);
    }

    return lines.join('\n');
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Build prompt parts + execute options for a single LLM call.
 *
 * @param {Object} options
 *   @param {string}          [options.role='host']
 *   @param {string}          [options.publisherId]
 *   @param {string}          [options.streamName]
 *   @param {string}          [options.contextHint]   One-sentence context
 *   @param {string|string[]} [options.allow='any']   Type constraint
 *   @param {boolean}         [options.webSearch=true]
 *   @param {number}          [options.maxTokens=2048]
 *
 * @return {{
 *   systemPrefix:  string,   // full static schema — goes in KV cache
 *   instructions:  string,   // tiny dynamic part — NOT cached
 *   executeOptions: object   // { webSearch, max_tokens }
 * }}
 */
function buildQueryPrompt(options) {
    options = options || {};

    return {
        systemPrefix:  _buildStaticPrefix(),
        instructions:  _buildInstructions(options),
        executeOptions: {
            webSearch:  options.webSearch !== false,
            max_tokens: options.maxTokens || 2048,
        },
    };
}

/**
 * Legacy alias — returns just a systemPrompt string for backward compat.
 * Combines prefix + minimal instructions into one string.
 */
function buildSystemPrompt(options) {
    const { systemPrefix, instructions } = buildQueryPrompt(options);
    return systemPrefix + (instructions ? '\n\n' + instructions : '');
}

/**
 * Cache key for the current schema version.
 * Use as the cacheKey argument to adapter.executeWithCachedPrefix().
 * Changes when the schema file is modified on disk.
 */
function getSchemaCacheKey() {
    _loadSchema(); // ensure mtime is populated
    return 'ai-pipeline-schema-v' + Math.floor(_schemaMtm / 1000);
}

function getSchema()    { return _loadSchema(); }
function reloadSchema() { _schema = null; _cachedPrefix = null; return _loadSchema(); }

module.exports = {
    buildQueryPrompt,
    buildSystemPrompt,
    getSchemaCacheKey,
    getSchema,
    reloadSchema,
    CATEGORIES,
};
