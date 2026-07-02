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
const EventEmitter = require('events');
const Q = require('Q');
const { buildQueryPrompt, getSchemaCacheKey } = require('./Prompt');
const AI_LLM                                  = require('./LLM');
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
        this._running       = false;
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
            if (self.session.wakeState === 'listening' &&
                (Date.now() - self.session.wakeStartedAt) > 5000) {

                const latestWakeEntry = self.session.wakeEntires[self.session.wakeEntires.length - 1];

                if (!latestWakeEntry.isFinal) return;

                // Timed out — process what we have, or drop it

                var fullCommand = self.onWakeEndWord(self.session);
                //console.log('pipeline: 20s ended', fullCommand)

                //latestWakeEntry.text = fullCommand;
                var result = await self.run(latestWakeEntry, fullCommand);
                self.emit('result', { result: result })
            }
        }, 5000);
    }

    /**
     * Run the full pipeline on a final transcript chunk.
     * @param {string} text
     * @return {Promise<object|null>}
     */
    async run(entry, wakeResult) {
        if (!entry) return null;
        if (this._running) return null;
        this._running = true;

        let text = typeof wakeResult == 'string' ? wakeResult : entry.text;
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
                    //console.log('LLM: pipeline: safebots request', wakeRequest);
                    if (entry.wakeUpTextLength != null) {
                        entry.wakeUpTextLength = entry.wakeUpTextLength + text.length;
                    }
                    text = wakeRequest;
                }

                //console.log('LLM: pipeline: is wake', typeof wakeResult);

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
            
            if (!wakeRequest && typeof wakeResult != 'string') { //finished wake request must be sent immediately, if this is regular transcript, send buffer
                let bufferText = '';
                let removeWakeRequest = false;
                let someChunksSent = false;
                let entiresToRemove = []
                for (let i in this.session.transcriptBuffer) {
                    let entry = this.session.transcriptBuffer[i];
                    bufferText += entry.text;
                    if(entry.isWakeUp) {
                        //console.log('LLM: pipeline: entry.isWakeUp');

                        removeWakeRequest = true;
                    }
                    if(entry.sentToLLM) {
                        someChunksSent = true;
                    }
                    entiresToRemove.push(entry);
                }

                let charactersNum = 200;
                if(someChunksSent) {
                    charactersNum = this.session.lastSentTextlength + 100;
                }

                if (bufferText.length < charactersNum) { //~10-15 seconds
                    //console.log('LLM: pipeline: buffer is short');

                    return;
                }

                if(removeWakeRequest) {
                    bufferText = bufferText.replace(/__WAKESTART__.*?__WAKEEND__/s, "");   
                }
                
                if (bufferText.length < charactersNum) { //~10-15 seconds
                    //console.log('LLM: pipeline: buffer is short 2');

                    return;
                }
                //console.log('LLM: pipeline: entiresToRemove', entiresToRemove.length);
                //console.log('LLM: pipeline: bufferText', bufferText);

                for (let e in entiresToRemove) {
                    for (let i = this.session.transcriptBuffer.length - 1; i >= 0; i--) {
                        if(entiresToRemove[e] == this.session.transcriptBuffer[i]) {
                            const entry = entiresToRemove[e];
                            entry.sentToLLM = true;
                            if(entry.isFinal) {
                                //this.session.transcriptBuffer.splice(i, 1);
                                //this.session.transcriptBufferMap.delete(entry.latestFinalAt);
                            }
                        }
                    }
                }


                if (this.session.transcriptBuffer.length > 8) {
                    let removed = this.session.transcriptBuffer.splice(0, this.session.transcriptBuffer.length - 8);
                    for (let e in removed) {
                        //console.log('LLM: pipeline: remove from buffer', removed[e].latestFinalAt);
                        this.session.transcriptBufferMap.delete(removed[e].latestFinalAt);
                    }
                }
                
                text = bufferText;
            } else {
                
            }

            const { systemPrefix, instructions, executeOptions } = buildQueryPrompt({
                text,
                entities: ner,
                sessionContext: {
                    currentTopic: this._currentTopic,
                    lastVisualization: this._lastVisualizationType || null,
                    // Optional soft hint — not a restriction
                    //hintedType: _detectSuggestedType(text, ner)
                }
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
                this.session.lastSentTextlength = text.length;
                //console.log('LLM: pipeline: sending to LLM', text);

                raw = await this._adapter.executeModel(
                    fullSystem,
                    { text },
                    executeOptions
                );
                
                //console.log('LLM: pipeline: LLM raw', raw);

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

                //console.log('LLM: pipeline: LLM raw 2');

            // Normalize adapter result to string
            const rawText = (typeof raw === 'string') ? raw
                : (raw && typeof raw.text === 'string') ? raw.text
                : (raw && raw.toString) ? String(raw)
                : null;

            if (!rawText) return null;

                //console.log('LLM: pipeline: LLM raw 3');
            const cleaned = rawText
                .replace(/^```(?:json)?\n?/i, '')
                .replace(/\n?```$/i, '')
                .trim();
            const result = JSON.parse(cleaned);

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
                result.wakeRequest = 'Safebots, ' + text;
            }
            return result;

        } catch (e) {
            //console.log('LLM: pipeline: error', e.message);
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

    detectWakeWord(transcript) {
        return _WAKE_WORDS.test(transcript)         // Layer 1: exact
            || this.detectWakeWordPhonetic(transcript)         // Layer 2: sound-alike
            || this.detectWakeWordLevenshtein(transcript);     // Layer 3: edit distance
    }

    detectWakeWordPhonetic(transcript) {
        var words = transcript.toLowerCase().split(/\s+/);
        // Try each word alone
        for (var i = 0; i < words.length; i++) {
            if (metaphone(words[i]) === _SAFEBOTS_META) return true;
        }
        // Try adjacent word pairs (for "safe bots", "save box", etc.)
        for (var i = 0; i < words.length - 1; i++) {
            var joined = words[i] + words[i + 1];
            if (metaphone(joined) === _SAFEBOTS_META) return true;
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
            if (this.levenshtein(words[i], target) <= 2) return true;
        }
        // Try adjacent pairs joined
        for (var i = 0; i < words.length - 1; i++) {
            var joined = words[i] + words[i + 1];
            if (this.levenshtein(joined, target) <= 2) return true;
        }
        return false;
    }

    extractCommandAfterWakeWord(transcript) {
        // Find where the wake word matched — replace variants with a marker, then split
        const self = this;
        var marked = transcript
            .replace(_WAKE_WORDS, '__WAKESTART__')
            // Fallback: also mark phonetic and Levenshtein matches
            .replace(/\b\S+\b/g, function (w) {
                if (metaphone(w) === _SAFEBOTS_META) return '__WAKESTART__';
                if (self.levenshtein(w, _WAKE_WORD) <= 2) return '__WAKESTART__';
                return w;
            });
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
            if(!session.wakeEntires.has(transcriptEntry)) {
                session.wakeEntires.add(transcriptEntry);
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
            }
            // No completion yet, keep accumulating (with timeout — see below)
            return true;  // consumed
        }
        // Not listening — check for wake word
        if ((!transcriptEntry.isWakeUp || (transcriptEntry.isWakeUp && transcriptEntry.wakeUpTextLength)) && this.detectWakeWord(transcript)) {
            
            //console.log('pipeline: started listening');
            session.wakeEntires = new Set();
            if(!session.wakeEntires.has(transcriptEntry)) {
                session.wakeEntires.add(transcriptEntry);
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
            }
            return true;  // consumed
        }

        return false;  // no wake context, process normally
    }

    onWakeEndWord(session) {
        //console.log('pipeline: detected end', session.wakeEntires.size);
        session.wakeState = null;

        let fullCommand = '';
        for (let wakeEntry of session.wakeEntires) {
            //console.log('pipeline: detected end for', wakeEntry);
            //if(!wakeEntry.text) continue;
            if (wakeEntry.isWakeUpStartEntry && wakeEntry.isWakeUpEndEntry) {
                const match = wakeEntry.text.match(/__WAKESTART__(.*?)__WAKEEND__/);
                fullCommand += match ? match[1].trim() : null;
            } else if (wakeEntry.isWakeUpStartEntry) {
                const after = wakeEntry.text.match(/__WAKESTART__(.*)$/s)?.[1] ?? "";
                fullCommand += after;
            } else if (wakeEntry.isWakeUpEndEntry) {
                const before = wakeEntry.text.match(/^(.*?)__WAKEEND__/s)?.[1] ?? "";
                fullCommand += before;
            } else { //!wakeEntry.isWakeUpStartEntry && !wakeEntry.isWakeUpEndEntry
                fullCommand += wakeEntry.text;
            }
        }
        //console.log('pipeline: fullCommand', fullCommand);

        session.wakeStartedAt = null;
        session.wakeEntires = null;
        session.wakeStartedAt = null;
        session.wakeLastUpdate = null;
        return fullCommand;
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
