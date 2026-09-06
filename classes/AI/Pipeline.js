'use strict';
/**
 * AI/classes/AI/Pipeline.js
 *
 * Transcript pipeline: NER → fast lookup → cached LLM query → proposal.
 *
 * KV CACHE STRATEGY
 * ─────────────────
 * Every call uses the same static schema prefix (byte-stable, several
 * thousand tokens — see Prompt.getStaticPrefixTokenCount()). The per-call
 * dynamic `instructions` block is small: role, context, constraint, plus the
 * rolling "OLDER CONTEXT" summary (see CONTEXT BUFFERING below).
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
 * CONTEXT BUFFERING
 * ──────────────────
 * The live transcript is fed to the AI as three parts (see
 * AI/classes/AI/TranscriptBuffer.js and AI/classes/AI/Prompt.js):
 *   1. systemPrefix — fixed, cached, includes rolling-summary instructions.
 *   2. instructions — includes the "OLDER CONTEXT" block: the structured
 *      contextSummary the AI returned last call (key_entities,
 *      topic_timeline, running_narrative).
 *   3. text — the real-time transcript: the last few overlapping ~200-char
 *      chunks, trimmed to a token budget via a local tiktoken estimate.
 * Every response includes an updated contextSummary, which Pipeline.run()
 * feeds back in as the next call's OLDER CONTEXT — a rolling, structured
 * summary instead of ever-growing raw transcript text.
 *
 * @module AI
 */
const EventEmitter = require('events');
const Q = require('Q');
const { buildQueryPrompt, getSchemaCacheKey, getStaticPrefixTokenCount } = require('./Prompt');
const AI_LLM                                  = require('./LLM');
const TranscriptBuffer                        = require('./TranscriptBuffer');
const PipelineLogger                          = require('./PipelineLogger');
const TranscriptFold                          = require('./TranscriptFold');
const Session                                 = require(Q.PLUGINS_DIR + '/Streams/classes/Streams/Transcript/Session');
// ── Intent heuristics ─────────────────────────────────────────────────────────
// Wake-word detection (syl1/syl2/REQUEST_PHRASES/metaphone/Levenshtein etc.)
// used to live here too, but now runs entirely client-side (see
// AI/web/js/AI/WakeWord.js) — the client decides when "Safebots" was said
// and when the command is complete, then sends the finished text straight to
// runSafebotsRequest() below. That fixed the premature-cutoff bug this
// machinery used to have (server-side timing was skewed by network/server
// load) and let all of it be deleted from here.

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

class Pipeline extends EventEmitter {

    /**
     * @param {Object} options
     * @param {Object}   options.Q
     * @param {Object}   options.session      { role, publisherId, streamName, userId, socket }
     * @param {Function} [options.emitToUser]
     * @param {Function} [options.onTopicChange]
     */
    constructor(options) {
        super(options);
        this.Q              = Q;
        this.session        = options.session;
        this._logger        = new PipelineLogger(this.session);
        this._running       = false;
        this._entiresQueue  = [];
        this._currentTopic  = null;
        this._onTopicChange = options.onTopicChange || null;
        this._emitToUser    = options.emitToUser    || null;
        this._lastGalleryQuery = null;
        this._lastGalleryQueryAt = 0;
        this._minGalleryHoldMs = 15 * 1000;

        try {
            this._adapter = AI_LLM.route('smart', { webSearch: true });
        } catch (e) {
            this._adapter = null;
            console.error(e);
            this.Q.log && this.Q.log('Pipeline: adapter init failed:', e.message);
        }

        // Whether the adapter supports explicit prefix caching.
        // If true → executeWithCachedPrefix.  If false → executeModel (auto-cached by provider).
        this._canCache = !!(this._adapter && this._adapter.supportsPrefixCache &&
                            this._adapter.supportsPrefixCache());

        this._galleryFlushInterval = setInterval(() => {
            if (!this._pendingGalleryQuery) return;
            if (Date.now() - this._lastGalleryQueryAt >= this._minGalleryHoldMs) {
                const next = this._pendingGalleryQuery;
                this._pendingGalleryQuery = null;
                this._lastGalleryQuery = next;
                this._lastGalleryQueryAt = Date.now();
                this._emitGalleryQuery(next);
            }
        }, 5000);
    }

    /**
     * Run the full pipeline on a final ambient transcript chunk (the
     * background narration buffer — see TranscriptBuffer.js).
     * @param {object} entry  A finalized entry from session.transcriptBuffer
     * @return {Promise<object|null>}
     */
    async run(entry) {
        if (!entry) return null;
        return this._runGuarded(() => this._runAmbient(entry));
    }

    /**
     * Run the pipeline on a complete "Safebots, ..." command already
     * assembled client-side (see AI/web/js/AI/WakeWord.js) — no buffering,
     * no wake-word detection, just NER/fast-lookup/gallery heuristics then
     * straight to the LLM. Shares the same OLDER CONTEXT (contextSummary)
     * the ambient pipeline maintains, and the same serialized-execution
     * guard, so a wake command and an ambient update can't race and
     * clobber contextSummary with an out-of-order write.
     * @param {string} text  e.g. "Safebots, show me a chart of Poland's GDP"
     * @return {Promise<object|null>}
     */
    async runSafebotsRequest(text) {
        if (!text) return null;
        return this._runGuarded(() => this._runSafebotsRequest(text));
    }

    /**
     * Serializes execution: only one of run()/runSafebotsRequest() actually
     * executes at a time. A call that arrives while one is in flight is
     * queued (not awaited by its caller — see the 'result' event, emitted
     * once the queued call eventually runs) rather than run concurrently,
     * since concurrent calls could both read/write contextSummary and
     * clobber each other with a stale write.
     * @private
     */
    async _runGuarded(fn) {
        if (this._running) {
            this._entiresQueue.push(fn);
            return null;
        }
        this._running = true;
        try {
            return await fn();
        } catch (e) {
            console.log('LLM: pipeline: error', e.message);
            this.Q.log && this.Q.log('Pipeline LLM error:', e.message);
            return null;
        } finally {
            this._running = false;
            if (this._entiresQueue.length != 0) {
                // No `return` here: a `return` inside `finally` overrides
                // whatever `try`/`catch` was about to return, which was
                // silently discarding the LLM result on every call that had
                // a backlog entry queued up by the time it finished — i.e.
                // almost every call, since interim WebSpeech results queue
                // up continuously while a call is in flight.
                //
                // The queued call itself is fire-and-forget from here (its
                // own caller already got null immediately), so forward its
                // eventual result via 'result' instead, or it would be
                // silently dropped too.
                const nextFn = this._entiresQueue.splice(0, 1)[0];
                this._runGuarded(nextFn).then((queuedResult) => {
                    if (queuedResult) this.emit('result', { result: queuedResult });
                });
            }
        }
    }

    /**
     * Chunk window + rolling summary for this session — see
     * AI/classes/AI/TranscriptBuffer.js. Lazily created since a session's
     * first utterance can arrive via either run() or runSafebotsRequest().
     * @private
     */
    _getTranscriptContext() {
        if (!this.session.transcriptContext) {
            this.session.transcriptContext = new TranscriptBuffer();
        }
        return this.session.transcriptContext;
    }

    /** @private */
    async _runAmbient(entry) {
        const text = entry.text;
        const ner = AI_LLM.extractEntities(text);

        // ── Background gallery — immediate, no LLM
        const queries = AI_LLM.buildSearchQueries(ner, this._currentTopic);
        if (queries.length) {
            this._maybeEmitGalleryQuery(queries[0]);
        }

        // ── Fast lookup — avatar prefix search, no LLM
        if (ner.persons && ner.persons.length) {
            const fast = await this._fastLookup(ner.persons);
            if (fast) return fast;
        }

        if (!this._adapter) return null;

        const transcriptContext = this._getTranscriptContext();

        // Pulls out and removes every finalized entry — see TranscriptFold
        // for why "finalized" is the safe moment to consume an entry (fixes
        // the duplication bug where entries used to linger and get
        // re-folded on every subsequent call, including the many interim
        // calls that share one entry while its text is still growing).
        const folded = TranscriptFold.foldFinalized(
            this.session.transcriptBuffer,
            this.session.transcriptBufferMap
        );
        const newText = folded.text;

        // Safety net: entries that never finalize (a stuck interim
        // recognition) would otherwise sit here forever. Trim the oldest
        // once that backlog gets unreasonable. Consumed (final) entries are
        // already gone by this point, so this only ever prunes entries
        // still waiting to finalize.
        if (this.session.transcriptBuffer.length > 8) {
            const removed = this.session.transcriptBuffer.splice(0, this.session.transcriptBuffer.length - 8);
            for (const removedEntry of removed) {
                this.session.transcriptBufferMap.delete(removedEntry.latestFinalAt);
            }
        }

        if (!newText) return null; // nothing newly finalized this call

        transcriptContext.addText(newText);

        // Rule #1: only call the AI once >= 200 new characters have
        // accumulated since the last chunk was finalized.
        if (!transcriptContext.hasEnoughNewText()) {
            return null;
        }
        transcriptContext.flushPendingChunk();

        // Real-time transcript = last N overlapping chunks, trimmed to the
        // token budget (rule #2).
        const windowText = transcriptContext.getRealtimeWindow();

        return this._runLLMQuery(windowText, ner, 'REGULAR_BUFFER');
    }

    /** @private */
    async _runSafebotsRequest(text) {
        const ner = AI_LLM.extractEntities(text);

        const queries = AI_LLM.buildSearchQueries(ner, this._currentTopic);
        if (queries.length) {
            this._maybeEmitGalleryQuery(queries[0]);
        }

        if (ner.persons && ner.persons.length) {
            const fast = await this._fastLookup(ner.persons);
            if (fast) return fast;
        }

        if (!this._adapter) return null;

        const result = await this._runLLMQuery(text, ner, 'SAFEBOT_REQUEST');
        if (result) result.wakeRequest = text;
        return result;
    }

    /**
     * The shared LLM-calling core: build the prompt, call the adapter,
     * parse the response, merge the rolling contextSummary back in, and log
     * the whole round-trip. Used by both the ambient buffer and Safebots
     * request paths — everything downstream of "we have text to send"
     * behaves identically regardless of which path produced that text.
     * @private
     */
    async _runLLMQuery(text, ner, type) {
        const transcriptContext = this._getTranscriptContext();

        const { systemPrefix, instructions, executeOptions } = buildQueryPrompt({
            text,
            entities: ner,
            contextSummary: transcriptContext.getSummary(),
            sessionContext: {
                currentTopic: this._currentTopic,
                lastVisualization: this._lastVisualizationType || null,
            }
        });

        // Everything sent to the AI this call — flushed to the log in
        // `finally` below regardless of how this call turns out, so a
        // parse failure or thrown error still leaves a full record.
        const logFields = {
            type,
            text,
            instructions,
            systemPrefixTokens: getStaticPrefixTokenCount()
        };

        try {
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
                this.session.lastSentTextlength = text.length;

                raw = await this._adapter.executeModel(
                    fullSystem,
                    { text },
                    executeOptions
                );
            }

            logFields.usage     = raw && raw.usage;
            logFields.citations = raw && raw.citations;

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

            logFields.rawResponse = rawText;

            if (!rawText) {
                logFields.error = 'empty response from adapter';
                return null;
            }

            const cleaned = rawText
                .replace(/^```(?:json)?\n?/i, '')
                .replace(/\n?```$/i, '')
                .trim();
            const result = JSON.parse(cleaned);
            logFields.result = result;

            // Persist the updated rolling summary regardless of "action" —
            // it's the model's memory of the talk, not a proposal, so it
            // must survive even on "none" turns. Stripped before returning
            // below (and before logging `result`, since it's logged as its
            // own field); it's internal bookkeeping, not part of the client
            // payload.
            if (result && result.contextSummary) {
                logFields.contextSummary = result.contextSummary;
                transcriptContext.setSummary(result.contextSummary);
                delete result.contextSummary;
            }

            if (!result || result.action === 'none' || !result.action) return null;
            // Confidence gate only applies to ambient/rolling-context
            // proposals (REGULAR_BUFFER) -- those are speculative, offered
            // unprompted, so a shaky guess should stay held back. A
            // SAFEBOT_REQUEST result is a direct answer to something the
            // user explicitly asked for by saying the wake word; even a
            // middling-confidence answer is worth showing (still gated by
            // host veto for 'propose' either way), not silently discarded.
            if (type !== 'SAFEBOT_REQUEST' && result.confidence != null && result.confidence < 0.7) {
                return null;
            }

            // Unpack inner JSON strings if the strict schema was used
            if (typeof result.visualizationData === 'string' && result.visualizationData) {
                try {
                    result.visualizationData = JSON.parse(result.visualizationData);
                } catch (e) {
                    console.error(e);
                    this.Q.log && this.Q.log(
                        'Pipeline: visualizationData not valid JSON string',
                        { raw: result.visualizationData.substring(0, 200) }
                    );
                    return null;
                }
            }
            if (typeof result.ephemeralPayload === 'string' && result.ephemeralPayload) {
                try {
                    result.ephemeralPayload = JSON.parse(result.ephemeralPayload);
                } catch (e) {
                    console.error(e);
                    this.Q.log && this.Q.log(
                        'Pipeline: ephemeralPayload not valid JSON string',
                        { raw: result.ephemeralPayload.substring(0, 200) }
                    );
                    return null;
                }
            }

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
            console.log('LLM: pipeline: error', e.message);
            this.Q.log && this.Q.log('Pipeline LLM error:', e.message);
            logFields.error = e.message;
            return null;
        } finally {
            this._logger.logCall(logFields);
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
        } catch (e) {
            console.error(e);
        }
        for (const name of personNames) {
            try {
                const uid = await this._lookupUser(name);
                if (uid) return { action: 'propose', confidence: 0.85, routing: 'shared',
                                  visualizationType: 'profile',
                                  visualizationData: { userId: uid, name } };
            } catch (e) {
                console.error(e);
            }
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

    /**
     * Decide whether to emit a new gallery query based on:
     *   - Has enough time passed since the last query change?
     *   - Does the new query meaningfully differ from the last?
     *
     * Returns true if a new query was emitted, false if suppressed.
     */
    _maybeEmitGalleryQuery(query) {
        const now = Date.now();
        const sinceLast = now - this._lastGalleryQueryAt;

        // Same query as before → no point re-emitting
        if (query === this._lastGalleryQuery) return false;

        // First query of the session → emit immediately
        if (!this._lastGalleryQuery) {
            this._lastGalleryQuery = query;
            this._lastGalleryQueryAt = now;
            this._emitGalleryQuery(query);
            return true;
        }

        // Within hold window → suppress, unless the new query is a
        // clearly stronger signal (different entity type, longer string)
        if (sinceLast < this._minGalleryHoldMs) {
            // Optional: track this as a "pending replacement" that fires
            // when the hold expires, so we don't permanently miss it
            this._pendingGalleryQuery = query;
            return false;
        }

        // Hold expired or strong signal → emit
        this._lastGalleryQuery = query;
        this._lastGalleryQueryAt = now;
        this._pendingGalleryQuery = null;
        this._emitGalleryQuery(query);
        return true;
    }

    _emitGalleryQuery(query) {
        if (!query || !this.session.publisherId) return;
        /* Session.postEphemeral({
            publisherId: this.session.publisherId,
            streamName: this.session.streamName,
            asUserId: this.session.userId,
            type: 'Streams/gallery/query',
            payload: { query: query }
        }); */

        Session.postMessage(Q, {
            publisherId: this.session.publisherId,
            streamName: this.session.streamName,
            byUserId: this.session.userId,
            byClientId: this.session.socketId,
            type: 'Streams/gallery/query',
            instructions: JSON.stringify({ query: query }),
        });
    }

    destroy() {
        if (this._galleryFlushInterval) clearInterval(this._galleryFlushInterval);
    }
}

module.exports = Pipeline;
