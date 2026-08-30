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
const WakeMarkers                             = require('./WakeMarkers');
const TranscriptFold                          = require('./TranscriptFold');
const Session                                 = require(Q.PLUGINS_DIR + '/Streams/classes/Streams/Transcript/Session');
var metaphone, _SAFEBOTS_META;
// ── Intent heuristics ─────────────────────────────────────────────────────────

const _COMPARISON_RE = /\b(vs\.?|versus|compared? to|difference between|better than|worse than)\b/i;
const _DEFINITION_RE = /\b(what is|define|definition of|explain|what does .+ mean)\b/i;
const _STAT_RE       = /\b\d[\d,]*\.?\d*\s*(billion|million|trillion|percent|%|B|M|T|K|bps|ms)\b/i;
const _SLIDE_RE      = /\b(show me|create a slide|make a slide|slide about|visual for|layout for)\b/i;
const _MAP_RE        = /\b(directions? to|how to get to|map of|navigate to|located? (in|at|near))\b/i;
const _SAFEBOTS_VARIANTS = /\b(?:safe|save|saved|same)\s?s?[bpm]o\w*\b/i;
const _WAKE_WORDS = _SAFEBOTS_VARIANTS;
const _WAKE_WORD = 'safebots';
//const _WAKE_WORD = /\b(?:hey|hi|ok|okay|so|yo)\s+(?:cubix|cubics|cubex|cubick|kubix|kubics|q\s?bix|cube\s?[ex])\b/i;
const _COMPLETION_MARKER_RE = /\b(thanks|thank you|go ahead|do it|proceed)\b\.?$/ig;

const syl1 = ["safe", "save", "said", "saved", "say", "same", "see", "set", "sill", "so", "sorry", "they", "think", "three"];
const syl2 = ["about", "thoughts", "box", "bots?", "boats?", "but", "boards?", "bod", "both", "mods", "bob's", "boss?", "what'?s?", "months", "words", "involts", "pause"];

// 2. Single-word misrecognitions (Requires lead-in filler)
const singleWords = ["sig", "seawboards?", "supports?", "symbols?"];

// 3. Lead-in Fillers
const optionalHeyLeadIn = "(?:hey\\s+)?";
const requiredHeyLeadIn = "hey\\s+";
const requiredLeadIn = "(?:hey|hi)\\s+";

// 4. Request / imperative phrases that let a BARE "Safebots" (no "hey"/"hi")
// open the mic on its own: politeness markers, modal requests, desire
// statements, imperative action verbs, and question formulations. Without
// one of these immediately after it, an unprefixed mention of the name
// mid-conversation is just narration ("...the safebots project...") rather
// than a command, and must NOT open the mic.
const REQUEST_PHRASES = [
    // politeness markers
    "please", "kindly", "if you (?:could|would|can)",
    // modal requests
    "can you", "could you", "would you", "will you", "won'?t you",
    // desire / intent statements
    "i want you to", "i need you to", "i'?d like you to",
    "i would like you to", "i'?m asking you to",
    // imperative action verbs directed at the assistant
    "show me", "tell me", "give me", "pull up", "bring up", "display",
    "explain", "walk me through", "help me (?:understand|with)", "find me",
    "look up", "search for", "get me", "put together", "create", "make",
    "generate", "build", "draw", "plot", "chart", "compare", "define",
    "summarize", "list",
    // question formulations
    "what'?s", "what is", "what are", "how many", "how much", "how do(?:es)?",
    "why is", "why are", "when did", "where is", "who is", "who was",
    "do you know",
    // directive lead-ins
    "go ahead and", "let'?s", "now show", "now tell", "i have a question"
];
const _REQUEST_PHRASE_RE_SOURCE = `(?:${REQUEST_PHRASES.join("|")})`;
const _REQUEST_PHRASE_START_RE  = new RegExp(`^${_REQUEST_PHRASE_RE_SOURCE}\\b`, "i");

// 5. Compiled Regex Construction
// Removed ^ from the beginning to match anywhere in the transcript string.
//
// WAKE_WORD_REGEX matches the wake word with an OPTIONAL "hey" lead-in --
// used only to find/mark where it occurred (extractCommandAfterWakeWord),
// not to decide whether to start listening. That decision is split into
// two separate rules, checked in detectWakeWord():
//   - WAKE_WORD_HEY_REGEX: "hey/hi Safebots" -- always opens the mic.
//   - WAKE_WORD_BARE_REQUEST_REGEX: bare "Safebots" with no lead-in --
//     opens the mic only when immediately followed by a request phrase
//     (see REQUEST_PHRASES above). Single-word misrecognitions are
//     excluded from this rule; they already require a "hey/hi" lead-in to
//     be trusted at all.
const WAKE_WORD_REGEX = new RegExp(
  `\\b(?:${optionalHeyLeadIn}(?:${syl1.join("|")})\\s+(?:${syl2.join("|")})|${requiredLeadIn}(?:${singleWords.join("|")}))\\b`,
  "i"
);

const WAKE_WORD_HEY_REGEX = new RegExp(
  `\\b(?:${requiredHeyLeadIn}(?:${syl1.join("|")})\\s+(?:${syl2.join("|")})|${requiredLeadIn}(?:${singleWords.join("|")}))\\b`,
  "i"
);

const WAKE_WORD_BARE_REQUEST_REGEX = new RegExp(
  `\\b(?:${syl1.join("|")})\\s+(?:${syl2.join("|")})\\b[\\s,.:;!—-]*${_REQUEST_PHRASE_RE_SOURCE}\\b`,
  "i"
);


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
        const self = this;
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
        this.session.wakeState = null;  // 'listening' | null

        try {
            this._adapter = AI_LLM.route('smacrt', { webSearch: true });
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


        this._wakeInterval = setInterval(async function () {
            // wakeLastUpdate refreshes on every wake-related utterance (see
            // processUtteranceWithWakeWord) -- this is meant to be a SILENCE
            // timeout ("no new speech in 3s -> wrap up"), not an absolute cap
            // on the whole command. Checking wakeStartedAt instead would cut
            // off any command longer than 3s while the speaker is still
            // actively talking.
            if (self.session.wakeState === 'listening' &&
                (Date.now() - self.session.wakeLastUpdate) > 3000) {

                let latestWakeEntry;

                for (const value of self.session.wakeEntries) {
                    latestWakeEntry = value;
                }
                
                if (!latestWakeEntry.isFinal) return;

                // Timed out — process what we have, or drop it

                var fullCommand = self.onWakeEndWord(self.session);
                //console.log('pipeline: 20s ended', fullCommand)

                //latestWakeEntry.text = fullCommand;
                var result = await self.run(latestWakeEntry, fullCommand);
                self.emit('result', { result: result })
            }
        }, 3000);
    }

    /**
     * Run the full pipeline on a final transcript chunk.
     * @param {string} text
     * @return {Promise<object|null>}
     */
    async run(entry, wakeResult) {
        //console.log('LLM: pipeline: run');

        if (!entry) return null;
        if (this._running) {
            this._entiresQueue.push({args: Array.prototype.slice.call(arguments)});
            return null;
        }
        this._running = true;

        let text = typeof wakeResult == 'string' ? wakeResult : entry.text;
        let logFields = null; // populated once we reach the LLM stage; flushed in finally
        try {
            //console.log('LLM: pipeline: wakeResult', typeof wakeResult);
            //console.log('LLM: pipeline: text', text);

            if(typeof metaphone == 'undefined') {
                const metaphoneModule = await import('metaphone');
                metaphone = metaphoneModule.metaphone;
                _SAFEBOTS_META = metaphone(_WAKE_WORD);
            }
            // ── 1. NER
            const ner = AI_LLM.extractEntities(text);


            let wakeRequest;
            if (typeof wakeResult != 'string') {
                wakeRequest = this.processUtteranceWithWakeWord(this.session, entry);
                if (wakeRequest === true) {
                    return;
                } else if (typeof wakeRequest == 'string') {
                    //console.log('LLM: pipeline: safebots request', entry.wakeUpTextLength, wakeRequest);
                    if (entry.wakeUpTextLength != null) {
                        entry.wakeUpTextLength = entry.wakeUpTextLength + text.length;
                    }
                    text = wakeRequest;
                }

                //console.log('LLM: pipeline: is wake', typeof wakeResult);
                //console.log('LLM: pipeline: wakeRequest', wakeRequest);

            }

            // ── 2. Background gallery — immediate, no LLM
            /* const queries = AI_LLM.buildSearchQueries(ner, this._currentTopic);
            if (queries.length) this._emitGalleryQuery(queries[0]); */
            const queries = AI_LLM.buildSearchQueries(ner, this._currentTopic);
            if (queries.length) {
                //console.log('LLM: pipeline: gallery', queries);
                this._maybeEmitGalleryQuery(queries[0]);
            }

            // ── 3. Fast lookup — avatar prefix search, no LLM
            if (ner.persons && ner.persons.length) {
                const fast = await this._fastLookup(ner.persons);
                if (fast) {
                    //console.log('LLM: pipeline: persons', fast);
                    return fast;
                }
            }

            // ── 4. LLM query
            if (!this._adapter) return null;

            //const intent = _detectIntent(text, ner);

            // Chunk window + rolling summary for this session — see
            // AI/classes/AI/TranscriptBuffer.js. Lazily created since a
            // session's first utterance can arrive via either path below.
            if (!this.session.transcriptContext) {
                this.session.transcriptContext = new TranscriptBuffer();
            }
            const transcriptContext = this.session.transcriptContext;

            if (!wakeRequest && typeof wakeResult != 'string') { //finished wake request must be sent immediately, if this is regular transcript, send buffer
                // Pulls out and removes every finalized entry — see
                // TranscriptFold for why "finalized" is the safe moment to
                // consume an entry (fixes the duplication bug where entries
                // used to linger and get re-folded on every subsequent call,
                // including the many interim calls that share one entry
                // while its text is still growing).
                const folded = TranscriptFold.foldFinalized(
                    this.session.transcriptBuffer,
                    this.session.transcriptBufferMap
                );
                let newText = folded.text;

                // Cut only the wake-request span(s) out of the finalized
                // text — never the whole entry, since an entry can carry
                // ordinary speech before __WAKESTART__ or after __WAKEEND__
                // that still belongs in the general buffer. The wake
                // request itself was already (or will be) submitted to the
                // AI separately by the wake pipeline (see onWakeEndWord).
                if (folded.hasWakeMarkers) {
                    newText = WakeMarkers.stripSpans(newText);
                }

                // Safety net: entries that never finalize (a stuck interim
                // recognition) would otherwise sit here forever. Trim the
                // oldest once that backlog gets unreasonable. Consumed
                // (final) entries are already gone by this point, so this
                // only ever prunes entries still waiting to finalize.
                if (this.session.transcriptBuffer.length > 8) {
                    let removed = this.session.transcriptBuffer.splice(0, this.session.transcriptBuffer.length - 8);
                    //console.log('LLM: pipeline: remove from buffer', removed.length);
                    for (const entry of removed) {
                        this.session.transcriptBufferMap.delete(entry.latestFinalAt);
                    }
                }

                if (!newText) return; // nothing newly finalized this call

                transcriptContext.addText(newText);

                // Rule #1: only call the AI once >= 200 new characters have
                // accumulated since the last chunk was finalized.
                if (!transcriptContext.hasEnoughNewText()) {
                    //console.log('LLM: pipeline: buffer is short', transcriptContext.pendingLength(), transcriptContext.chunkSize);
                    return;
                }
                transcriptContext.flushPendingChunk();

                // Real-time transcript = last N overlapping chunks, trimmed
                // to the token budget (rule #2). text is the raw window;
                // the rolling summary goes into "instructions" below as the
                // Older Context block.
                text = transcriptContext.getRealtimeWindow();
            }

            const { systemPrefix, instructions, executeOptions } = buildQueryPrompt({
                text,
                entities: ner,
                contextSummary: transcriptContext.getSummary(),
                sessionContext: {
                    currentTopic: this._currentTopic,
                    lastVisualization: this._lastVisualizationType || null,
                    // Optional soft hint — not a restriction
                    //hintedType: _detectSuggestedType(text, ner)
                }
            });

            // Everything sent to the AI this call — flushed to the log in
            // `finally` below regardless of how this call turns out, so a
            // parse failure or thrown error still leaves a full record.
            logFields = {
                type:                typeof wakeResult == 'string' ? 'SAFEBOT_REQUEST' : 'REGULAR_BUFFER',
                text,
                instructions,
                systemPrefixTokens:  getStaticPrefixTokenCount()
            };

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
                console.log('LLM: pipeline: sending to LLM');

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

                //console.log('LLM: pipeline: LLM raw 2');

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

                //console.log('LLM: pipeline: LLM raw 3');
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

                //console.log('LLM: pipeline: LLM raw 4');
            if (!result || result.action === 'none' || !result.action) return null;
            if (result.confidence != null && result.confidence < 0.7) return null;

                //console.log('LLM: pipeline: LLM raw 5');
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
                //console.log('LLM: pipeline: LLM raw 6');
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

                //console.log('LLM: pipeline: LLM raw 7');
            // Attach web search citations from the adapter response, if any.
            // Anthropic adapter always returns a citations[] (empty when no web
            // search was used). Other adapters may not populate this field.
            if (raw && Array.isArray(raw.citations) && raw.citations.length) {
                result.citations = raw.citations;
            }

                //console.log('LLM: pipeline: LLM raw 8');
            // Topic change for clip cutting
            const newTopic = this._extractTopic(result);
            if (newTopic && newTopic !== this._currentTopic) {
                const prev = this._currentTopic;
                this._currentTopic = newTopic;
                if (prev && this._onTopicChange) this._onTopicChange(prev, newTopic);
            }

                //console.log('LLM: pipeline: LLM raw 9');
            if(wakeRequest) {
            result.wakeRequest = text;
            }
            return result;

        } catch (e) {
            console.log('LLM: pipeline: error', e.message);
            this.Q.log && this.Q.log('Pipeline LLM error:', e.message);
            if (logFields) logFields.error = e.message;
            return null;
        } finally {
            if (logFields) this._logger.logCall(logFields);
            this._running = false;
            if (this._entiresQueue.length != 0) {
                let queueItem = this._entiresQueue.splice(0, 1)[0];
                // No `return` here: a `return` inside `finally` overrides
                // whatever `try`/`catch` was about to return, which was
                // silently discarding the LLM result on every call that had
                // a backlog entry queued up by the time it finished — i.e.
                // almost every call, since interim WebSpeech results queue
                // up continuously while a call is in flight.
                //
                // The queued run itself is fire-and-forget from here (its
                // caller already got this call's return value), so forward
                // its eventual result the same way the wake-interval timeout
                // path does, or it would be silently dropped too.
                this.run.apply(this, queueItem.args).then((queuedResult) => {
                    if (queuedResult) this.emit('result', { result: queuedResult });
                });
            }
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

    /**
     * Two ways a transcript can open the mic:
     *   1. "Hey/Hi Safebots" (exact or a fuzzy/phonetic near-miss) --
     *      always triggers, whatever follows.
     *   2. Bare "Safebots" with no "hey/hi" lead-in -- triggers only when
     *      immediately followed by a request/imperative phrase (see
     *      REQUEST_PHRASES), so an incidental mention of the name doesn't
     *      hijack listening.
     * Layers 2/3 (phonetic, Levenshtein) apply this same rule per candidate
     * match via _wakeWordContextOk().
     */
    detectWakeWord(transcript) {
        if(WAKE_WORD_HEY_REGEX.test(transcript)) {
            //console.log('detectWakeWord 1: hey + wake word')
            return true;
        }
        if(WAKE_WORD_BARE_REQUEST_REGEX.test(transcript)) {
            //console.log('detectWakeWord 1b: bare wake word + request phrase')
            return true;
        }
        if(this.detectWakeWordPhonetic(transcript)) {
            //console.log('detectWakeWord 2')
            return true;
        }
        if(this.detectWakeWordLevenshtein(transcript)) {
            //console.log('detectWakeWord 3')
            return true;
        }
        return false;
    }

    /**
     * Gate for a fuzzy (phonetic/Levenshtein) wake-word candidate spanning
     * words[startIdx..endIdx]: allow it either because "hey"/"hi"
     * immediately precedes it, or -- with no such lead-in -- because a
     * request/imperative phrase immediately follows it. Mirrors the
     * WAKE_WORD_HEY_REGEX / WAKE_WORD_BARE_REQUEST_REGEX split above, for
     * candidates the exact regexes didn't catch.
     */
    _wakeWordContextOk(words, startIdx, endIdx) {
        var before = startIdx > 0 ? words[startIdx - 1].replace(/[^a-z]/gi, '') : '';
        if (/^(?:hey|hi)$/i.test(before)) return true;
        var window = words.slice(endIdx + 1, endIdx + 7).join(' ');
        return _REQUEST_PHRASE_START_RE.test(window);
    }

    detectWakeWordPhonetic(transcript) {
        var words = transcript.toLowerCase().split(/\s+/);
        // Try each word alone
        for (var i = 0; i < words.length; i++) {
            if (metaphone(words[i]) === _SAFEBOTS_META && this._wakeWordContextOk(words, i, i)) return true;
        }
        // Try adjacent word pairs (for "safe bots", "save box", etc.)
        for (var i = 0; i < words.length - 1; i++) {
            var joined = words[i] + words[i + 1];
            if (metaphone(joined) === _SAFEBOTS_META && this._wakeWordContextOk(words, i, i + 1)) return true;
        }
        return false;
    }

    levenshtein(a, b) {
        if (!a.length) return b.length;
        if (!b.length) return a.length;
        var matrix = [];
        for (var i = 0; i <= b.length; i++) matrix[i] = [i];
        for (var j = 0; j <= a.length; j++) matrix[0][j] = j;
        for (var i = 1; i <= b.length; i++) {
            for (var j = 1; j <= a.length; j++) {
                if (b[i - 1] === a[j - 1]) matrix[i][j] = matrix[i - 1][j - 1];
                else matrix[i][j] = Math.min(
                    matrix[i - 1][j - 1] + 1,
                    matrix[i][j - 1] + 1,
                    matrix[i - 1][j] + 1
                );
            }
        }
        return matrix[b.length][a.length];
    }

    detectWakeWordLevenshtein(transcript) {
        var target = _WAKE_WORD;
        var words = transcript.toLowerCase().split(/\s+/);
        // Try each word — allow up to 2 edits
        for (var i = 0; i < words.length; i++) {
            if (this.levenshtein(words[i], target) <= 2 && this._wakeWordContextOk(words, i, i)) return true;
        }
        // Try adjacent pairs joined
        for (var i = 0; i < words.length - 1; i++) {
            var joined = words[i] + words[i + 1];
            if (this.levenshtein(joined, target) <= 2 && this._wakeWordContextOk(words, i, i + 1)) return true;
        }
        return false;
    }

    extractCommandAfterWakeWord(transcript) {
        // Find where the wake word matched — replace variants with a marker, then split
        var marked = transcript.replace(WAKE_WORD_REGEX, '__WAKESTART__');

        // Fallback: the exact-pattern regex found nothing, but detectWakeWord() may still
        // have matched via the phonetic/Levenshtein layers (single word or adjacent pair
        // joined) — mirror that same logic here so we can mark where it matched.
        if (marked.indexOf('__WAKESTART__') === -1) {
            var tokens = marked.split(/(\s+)/); // keep whitespace separators so we can rejoin
            var wordIndices = [];
            for (var i = 0; i < tokens.length; i++) {
                if (!/^\s*$/.test(tokens[i])) wordIndices.push(i);
            }
            var matched = false;
            for (var k = 0; k < wordIndices.length && !matched; k++) {
                var idx = wordIndices[k];
                var w = tokens[idx].toLowerCase();
                if (metaphone(w) === _SAFEBOTS_META || this.levenshtein(w, _WAKE_WORD) <= 2) {
                    tokens[idx] = '__WAKESTART__';
                    matched = true;
                }
            }
            if (!matched) {
                for (var k = 0; k < wordIndices.length - 1 && !matched; k++) {
                    var idx1 = wordIndices[k], idx2 = wordIndices[k + 1];
                    var joined = (tokens[idx1] + tokens[idx2]).toLowerCase();
                    if (metaphone(joined) === _SAFEBOTS_META || this.levenshtein(joined, _WAKE_WORD) <= 2) {
                        tokens[idx1] = '__WAKESTART__';
                        for (var j = idx1 + 1; j <= idx2; j++) tokens[j] = '';
                        matched = true;
                    }
                }
            }
            marked = tokens.join('');
        }

        var parts = marked.split('__WAKESTART__');
        // Everything after the wake word (and past any leading punctuation/whitespace)
        return {
            marked: marked,
            textBefore: parts[0],
            command: parts.slice(1).join(' ').replace(/^[\s,.:;]+/, '').trim()
        }
    }

    processUtteranceWithWakeWord(session, transcriptEntry) {
        let transcript = transcriptEntry.text;

        // Are we already listening for a follow-up?
        if (session.wakeState === 'listening') {
            //console.log('pipeline: listening');
            if(!session.wakeEntries.has(transcriptEntry)) {
                session.wakeEntries.add(transcriptEntry);
                transcriptEntry.isWakeUp = true;
            }

            session.wakeLastUpdate = Date.now();

            if(transcriptEntry.isWakeUpStartEntry) {
                let parsedParts = this.extractCommandAfterWakeWord(transcript);
                transcriptEntry.text = parsedParts.marked;
                //console.log('pipeline: parsedParts.marked 1', parsedParts);
            }
            

            // Add to accumulated command
            //session.wakeCommand = (session.wakeCommand || '') + ' ' + transcript;
            // Check for completion marker
            //console.log('pipeline: transcript 1', transcriptEntry.text);
            let completionCheck = this.isCompletionMarker(transcriptEntry.text);
            if (completionCheck.isCompletion) {
                transcriptEntry.text = completionCheck.marked;
                transcriptEntry.isWakeUpEndEntry = true;
                return this.onWakeEndWord(session);
            } else {
                let fullCommand = 'Safebots, ' + this.getFullCommand(this.session).replace(/__WAKESTART__.*?__WAKEEND__/s, "");
                //console.log('fullCommand', fullCommand)
                this._logger.logWakeEvent('PENDING_LISTENING', fullCommand);
                Q.plugins.Users.Socket.emitToUser(this.session.userId, 'Streams/pendingListening', {
                    requestText: fullCommand
                });
            }
            // No completion yet, keep accumulating (with timeout — see below)
            return true;  // consumed
        }
        // Not listening — check for wake word
        if ((!transcriptEntry.isWakeUp || (transcriptEntry.isWakeUp && transcriptEntry.wakeUpTextLength)) && this.detectWakeWord(transcript)) {
            
            //console.log('pipeline: started listening: ' + transcript);
            this._logger.logWakeEvent('STARTED_LISTENING', transcript);

            session.wakeEntries = new Set();
            if(!session.wakeEntries.has(transcriptEntry)) {
                session.wakeEntries.add(transcriptEntry);
            }
            transcriptEntry.isWakeUp = true;
            transcriptEntry.isWakeUpStartEntry = true;
            session.wakeState = 'listening';
            let parsedParts = this.extractCommandAfterWakeWord(transcript);
            //console.log('pipeline: parsedParts.marked', parsedParts);

            transcriptEntry.text = parsedParts.marked;
            session.wakeStartedAt = Date.now();
            session.wakeLastUpdate = Date.now();
            // Check if wake and completion arrived in same utterance
            //console.log('pipeline: transcript 2', transcriptEntry.text);
            let completionCheck = this.isCompletionMarker(transcriptEntry.text)
            if (completionCheck.isCompletion) {
                transcriptEntry.text = completionCheck.marked;
                transcriptEntry.isWakeUpEndEntry = true;
                return this.onWakeEndWord(session);
            } else {
                Q.plugins.Users.Socket.emitToUser(this.session.userId, 'Streams/startedListening', {
                    
                });
            }
            return true;  // consumed
        }

        return false;  // no wake context, process normally
    }

    getFullCommand(session) {
        // Collect each entry's extracted contribution and join only the
        // non-empty ones with a single space. Unconditionally prepending a
        // separator per entry (as this used to) means an entry that
        // contributes nothing -- e.g. the wake-word entry itself, once
        // "Hey Safebots" is stripped out -- still adds a bare separator, so
        // a run of such entries degenerates into pure noise with the real
        // command text buried or lost entirely.
        const parts = [];
        for (let wakeEntry of session.wakeEntries) {
            //console.log('pipeline: detected end for', wakeEntry.text);
            let piece;
            if (wakeEntry.isWakeUpStartEntry && wakeEntry.isWakeUpEndEntry) {
                const match = wakeEntry.text.match(/__WAKESTART__(.*?)__WAKEEND__/s);
                piece = match ? match[1] : '';
            } else if (wakeEntry.isWakeUpStartEntry) {
                piece = wakeEntry.text.match(/__WAKESTART__(.*)$/s)?.[1] ?? '';
            } else if (wakeEntry.isWakeUpEndEntry) {
                piece = wakeEntry.text.match(/^(.*?)__WAKEEND__/s)?.[1] ?? '';
            } else { //!wakeEntry.isWakeUpStartEntry && !wakeEntry.isWakeUpEndEntry
                piece = wakeEntry.text;
            }
            piece = (piece || '').trim();
            if (piece) parts.push(piece);
        }
        return parts.join(' ');
    }

    onWakeEndWord(session) {
        //console.log('pipeline: detected end', session.wakeEntries.size);
        session.wakeState = null;

        let fullCommand = this.getFullCommand(session);
        //console.log('pipeline: fullCommand', fullCommand);
        this._logger.logWakeEvent('ENDED_LISTENING', fullCommand);

        session.wakeStartedAt = null;
        session.wakeEntries = null;
        session.wakeStartedAt = null;
        session.wakeLastUpdate = null;
        Q.plugins.Users.Socket.emitToUser(this.session.userId, 'Streams/endedListening', {
                    
        });
        return 'Safebots, ' + fullCommand;
    }

    isCompletionMarker(text) {
        const matches = [...text.matchAll(_COMPLETION_MARKER_RE)];

        let result = null;
        let command = null;
        if (matches.length) {
            const last = matches[matches.length - 1];
            command = text.slice(0, last.index);
            result =
                command +
                "__WAKEEND__" +
                text.slice(last.index + last[0].length);           
        }

        return {
            marked: result,
            command: command,
            isCompletion: result != null
        }
    }

    destroy() {
        if (this._galleryFlushInterval) clearInterval(this._galleryFlushInterval);
        if (this._wakeInterval) clearInterval(this._wakeInterval);
    }
}

module.exports = Pipeline;
