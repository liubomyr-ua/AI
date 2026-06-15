'use strict';
/**
 * AI/classes/AI/Pipeline.js
 *
 * Transcript pipeline: NER → fast lookup → cached LLM query → proposal.
 *
 * KV CACHE STRATEGY
 * ─────────────────
 * Every call uses the same ~2900-token static schema prefix (byte-stable).
 * The per-call dynamic part is ~20-60 tokens (role, context, constraint).
 *
 * Anthropic adapter (supportsPrefixCache = true):
 *   executeWithCachedPrefix(cacheKey, systemPrefix, inputs, {
 *     additionalInstructions: instructions,   ← uncached second system block
 *     webSearch: true, max_tokens: 2048
 *   })
 *   Result: schema prefix cached at 0.1x price after first call.
 *   Cache TTL: 5 min (resets on every hit — stays warm during a show).
 *
 * OpenAI adapter (supportsPrefixCache = false):
 *   executeModel(systemPrefix + '\n\n' + instructions, inputs, executeOptions)
 *   OpenAI auto-caches any prompt prefix ≥1024 tokens transparently.
 *
 * INTENT DETECTION
 * ────────────────
 * NER + regex detect the dominant intent and set a type constraint sentence
 * in `instructions`. The full schema is always in `systemPrefix` (no slicing),
 * so the constraint is just: "Only use these types: profile, article".
 *
 * @module AI
 */

const { buildQueryPrompt, getSchemaCacheKey } = require('./Prompt');
const AI_LLM                                  = require('./LLM');

// ── Intent heuristics ─────────────────────────────────────────────────────────

const _COMPARISON_RE = /\b(vs\.?|versus|compared? to|difference between|better than|worse than)\b/i;
const _DEFINITION_RE = /\b(what is|define|definition of|explain|what does .+ mean)\b/i;
const _STAT_RE       = /\b\d[\d,]*\.?\d*\s*(billion|million|trillion|percent|%|B|M|T|K|bps|ms)\b/i;
const _SLIDE_RE      = /\b(show me|create a slide|make a slide|slide about|visual for|layout for)\b/i;
const _MAP_RE        = /\b(directions? to|how to get to|map of|navigate to|located? (in|at|near))\b/i;

function _detectIntent(text, ner) {
    if (_SLIDE_RE.test(text))
        return { allow: ['slide'],
                 contextHint: 'Speaker requested a visual slide layout.' };
    if (_MAP_RE.test(text))
        return { allow: ['map'],
                 contextHint: 'Speaker asked for directions or a location.' };
    if (_DEFINITION_RE.test(text) && !ner.persons.length)
        return { allow: ['glossary', 'article'],
                 contextHint: 'Speaker asked for a definition or explanation.' };
    if (_COMPARISON_RE.test(text))
        return { allow: ['comparison', 'table', 'barChart'],
                 contextHint: 'Speaker is comparing two or more things.' };
    if (ner.persons.length && !ner.numbers.length)
        return { allow: ['profile', 'article', 'slide'],
                 contextHint: 'Speaker mentioned: ' + ner.persons.slice(0, 2).join(', ') };
    if (ner.numbers.length && _STAT_RE.test(text))
        return { allow: ['stat', 'barChart', 'lineChart', 'table'],
                 contextHint: 'Speaker stated a statistic.' };
    return { allow: 'any', contextHint: null };
}

// ── Pipeline ──────────────────────────────────────────────────────────────────

class Pipeline {

    /**
     * @param {Object} options
     * @param {Object}   options.Q
     * @param {Object}   options.session      { role, publisherId, streamName, userId, socket }
     * @param {Function} [options.emitToUser]
     * @param {Function} [options.onTopicChange]
     */
    constructor(options) {
        this.Q              = options.Q;
        this.session        = options.session;
        this._running       = false;
        this._currentTopic  = null;
        this._onTopicChange = options.onTopicChange || null;
        this._emitToUser    = options.emitToUser    || null;

        try {
            this._adapter = AI_LLM.route('smart', { webSearch: true });
        } catch (e) {
            this._adapter = null;
            this.Q.log && this.Q.log('Pipeline: adapter init failed:', e.message);
        }

        // Whether the adapter supports explicit prefix caching.
        // If true → executeWithCachedPrefix.  If false → executeModel (auto-cached by provider).
        this._canCache = !!(this._adapter && this._adapter.supportsPrefixCache &&
                            this._adapter.supportsPrefixCache());
    }

    /**
     * Run the full pipeline on a final transcript chunk.
     * @param {string} text
     * @return {Promise<object|null>}
     */
    async run(text) {
        if (!text || !text.trim()) return null;
        if (this._running) return null;
        this._running = true;

        try {
            // ── 1. NER
            const ner = AI_LLM.extractEntities(text);

            // ── 2. Background gallery — immediate, no LLM
            const queries = AI_LLM.buildSearchQueries(ner, this._currentTopic);
            if (queries.length) this._emitGalleryQuery(queries[0]);

            // ── 3. Fast lookup — avatar prefix search, no LLM
            if (ner.persons && ner.persons.length) {
                const fast = await this._fastLookup(ner.persons);
                if (fast) return fast;
            }

            // ── 4. LLM query
            if (!this._adapter) return null;

            const intent  = _detectIntent(text, ner);
            const { systemPrefix, instructions, executeOptions } = buildQueryPrompt({
                role:        this.session.role,
                publisherId: this.session.publisherId,
                streamName:  this.session.streamName,
                allow:       intent.allow,
                contextHint: intent.contextHint,
                webSearch:   true,
                maxTokens:   2048,
            });

            let raw;
            if (this._canCache) {
                // ── Anthropic path: explicit prefix cache ─────────────────────
                // systemPrefix → cached system block (cache_control: ephemeral)
                // instructions → uncached second system block
                // text         → user message
                raw = await this._adapter.executeWithCachedPrefix(
                    getSchemaCacheKey(),
                    systemPrefix,
                    { text },
                    Object.assign({}, executeOptions, {
                        additionalInstructions: instructions,
                    })
                );
            } else {
                // ── OpenAI / other path: auto-caching ─────────────────────────
                // Concatenate into one system prompt.
                // OpenAI auto-caches any prefix ≥1024 tokens.
                const fullSystem = systemPrefix + (instructions ? '\n\n' + instructions : '');
                raw = await this._adapter.executeModel(
                    fullSystem,
                    { text },
                    executeOptions
                );
            }

            // Log cache hit/miss for the first few calls during testing
            if (raw && raw.usage) {
                const u = raw.usage;
                if (u.cache_read_input_tokens || u.cache_creation_input_tokens) {
                    this.Q.log && this.Q.log(
                        'Pipeline cache:',
                        u.cache_read_input_tokens    ? 'HIT  ' + u.cache_read_input_tokens + ' tokens read from cache'
                        : u.cache_creation_input_tokens ? 'WRITE ' + u.cache_creation_input_tokens + ' tokens written to cache'
                        : ''
                    );
                }
            }

            // Normalize adapter result to string
            const rawText = (typeof raw === 'string') ? raw
                : (raw && typeof raw.text === 'string') ? raw.text
                : (raw && raw.toString) ? String(raw)
                : null;

            if (!rawText) return null;

            const cleaned = rawText
                .replace(/^```(?:json)?\n?/i, '')
                .replace(/\n?```$/i, '')
                .trim();
            const result = JSON.parse(cleaned);

            if (!result || result.action === 'none' || !result.action) return null;
            if (result.confidence != null && result.confidence < 0.7) return null;

            // Attach web search citations from the adapter response, if any.
            // Anthropic adapter always returns a citations[] (empty when no web
            // search was used). Other adapters may not populate this field.
            if (raw && Array.isArray(raw.citations) && raw.citations.length) {
                result.citations = raw.citations;
            }

            // Topic change for clip cutting
            const newTopic = this._extractTopic(result);
            if (newTopic && newTopic !== this._currentTopic) {
                const prev = this._currentTopic;
                this._currentTopic = newTopic;
                if (prev && this._onTopicChange) this._onTopicChange(prev, newTopic);
            }

            return result;

        } catch (e) {
            this.Q.log && this.Q.log('Pipeline LLM error:', e.message);
            return null;
        } finally {
            this._running = false;
        }
    }

    // ── Fast lookup ───────────────────────────────────────────────────────────

    async _fastLookup(personNames) {
        try {
            const streams = await AI_LLM.lookupStreams(personNames, { limit: 1 });
            if (streams && streams.length) {
                const s = streams[0];
                return { action: 'propose', confidence: 0.85, routing: 'shared',
                         visualizationType: 'profile',
                         visualizationData: { userId: s.publisherId || null,
                                              name: s.title || personNames[0] } };
            }
        } catch (e) {}
        for (const name of personNames) {
            try {
                const uid = await this._lookupUser(name);
                if (uid) return { action: 'propose', confidence: 0.85, routing: 'shared',
                                  visualizationType: 'profile',
                                  visualizationData: { userId: uid, name } };
            } catch (e) {}
        }
        return null;
    }

    async _lookupUser(name) {
        if (!this.Q || !this.Q.Users || typeof this.Q.Users.byPrefix !== 'function') return null;
        const r = await this.Q.Users.byPrefix(name, { limit: 1 });
        return (r && r[0]) ? r[0].id : null;
    }

    _extractTopic(result) {
        if (!result || !result.visualizationData) return null;
        const d = result.visualizationData;
        return d.term || d.label || d.title || d.name || d.topic || null;
    }

    _emitGalleryQuery(query) {
        if (!query || !this.session.publisherId) return;
        const payload = { publisherId: this.session.publisherId,
                          streamName:  this.session.streamName,
                          type:        'Streams/gallery/query',
                          payload:     { query } };
        if (this._emitToUser) {
            this._emitToUser(this.session.userId, 'AI/ephemeral', payload);
        } else if (this.session.socket) {
            this.session.socket.emit('AI/ephemeral', payload);
        }
    }
}

module.exports = Pipeline;
