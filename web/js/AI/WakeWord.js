"use strict";

/**
 * AI/web/js/AI/WakeWord.js
 *
 * Browser-side "Safebots" wake-word detector. Ported from the server-side
 * detection that used to live entirely in AI/classes/AI/Pipeline.js — moving
 * it to the client removes the browser -> socket -> server relay hop from
 * the "did the speaker pause" timing decision, which is what caused
 * commands to get cut off mid-sentence under network/server load.
 *
 * Two ways an utterance opens the mic (see detectWakeWord):
 *   1. "Hey/Hi Safebots" -- always triggers, whatever follows.
 *   2. Bare "Safebots" (no "hey"/"hi") -- triggers only when immediately
 *      followed by a request/imperative phrase (see REQUEST_PHRASES), so an
 *      incidental mention of the name mid-conversation doesn't hijack
 *      listening.
 *
 * Feed it raw Web Speech API onresult events; it emits:
 *   'wakeStart'      (transcript)   -- the wake phrase was just detected
 *   'pendingCommand' (text)         -- still listening, command growing
 *   'wakeEnd'        (fullCommand)  -- listening ended (completion phrase
 *                                      or caller-driven timeout -- see
 *                                      onWakeEndWord)
 *   'command'        (text)         -- the finished "Safebots, ..." request,
 *                                      ready to hand off to the AI pipeline
 *
 * procesTranscriptEvent() also RETURNS the ambient-safe leftover of the fed
 * event -- whatever text isn't part of an open or just-finished wake command
 * (e.g. "and next, let's look at Q3 earnings" trailing after a "...thanks"
 * that closed a command, or narration before a "Hey Safebots" that opens
 * one) -- as a {transcript, isFinal, confidence, latestFinalAt} object ready
 * for Q.Streams.Transcript.send(), or null when this event contributed
 * nothing but command text. Callers that want the regular ambient/rolling
 * transcript pipeline to never see wake-word command text (so it can't
 * duplicate a wake-triggered proposal as an ambient one -- see
 * Media/presentation/commands.js's _connectWakeWord) should forward this
 * return value instead of also handing Q.Speech.Recognition results to
 * Q.Streams.Transcript directly.
 *
 * Usage:
 *   Q.require(Q.url('{{AI}}/js/AI/WakeWord.js'), function (WakeWord) {
 *       var ww = new WakeWord();
 *       ww.on('command', function (text) { ... });
 *       Q.Speech.Recognition.onResult.set(function (e) {
 *           var ambientChunk = ww.procesTranscriptEvent(e);
 *           if (ambientChunk) Q.Streams.Transcript.send(ambientChunk);
 *       }, 'MyTool');
 *   });
 *
 * NOTE ON METAPHONE: the phonetic fuzzy-match layer (detectWakeWordPhonetic)
 * is ported and functional, but there's no browser-compatible metaphone
 * build wired up yet, so detectWakeWord() only exercises the two exact
 * regexes for now -- same as the currently-active production behavior.
 * Source a browser metaphone port, set it below, and uncomment the calls in
 * detectWakeWord() to enable that layer.
 *
 * @module AI
 * @class AI.WakeWord
 */
(function (root, factory) {
	if (typeof module === 'object' && module.exports) {
		module.exports = factory();
	} else {
		root.AI        = root.AI        || {};
		root.AI.WakeWord = factory();
		if (typeof Q !== 'undefined' && Q.exports) {
			Q.exports(root.AI.WakeWord);
		}
	}
}(typeof self !== 'undefined' ? self : this, function () {
	'use strict';

	// Tiny EventEmitter — mirrors AI.Voice's.
	function Emitter() { this._listeners = {}; }
	Emitter.prototype.on = function (ev, fn) {
		(this._listeners[ev] = this._listeners[ev] || []).push(fn);
		return this;
	};
	Emitter.prototype.off = function (ev, fn) {
		if (!this._listeners[ev]) return this;
		this._listeners[ev] = this._listeners[ev].filter(function (f) { return f !== fn; });
		return this;
	};
	Emitter.prototype.emit = function (ev) {
		var args = Array.prototype.slice.call(arguments, 1);
		(this._listeners[ev] || []).forEach(function (fn) {
			try { fn.apply(null, args); } catch (e) { /* swallow listener errors */ }
		});
	};

	// ── Wake-word vocabulary (ported from AI/classes/AI/Pipeline.js) ──────────

	var _WAKE_WORD = 'safebots';
	var _COMPLETION_MARKER_RE = /\b(thanks|thank you|go ahead|do it|proceed)\b\.?$/ig;

	var syl1 = ["safe", "save", "said", "saved", "say", "same", "see", "set", "sill", "so", "sorry", "they", "think", "three"];
	var syl2 = ["about", "thoughts", "box", "bots?", "boats?", "but", "boards?", "bod", "both", "mods", "bob's", "boss?", "what'?s?", "months", "words", "involts", "pause", "spots"];

	// Single-word misrecognitions (requires a "hey/hi" lead-in filler).
	var singleWords = ["sig", "seawboards?", "supports?", "symbols?"];

	// Lead-in fillers.
	var optionalHeyLeadIn = "(?:hey\\s+)?";
	var requiredHeyLeadIn = "hey\\s+";
	var requiredLeadIn    = "(?:hey|hi)\\s+";

	// Request / imperative phrases that let a BARE "Safebots" (no "hey"/"hi")
	// open the mic on its own: politeness markers, modal requests, desire
	// statements, imperative action verbs, and question formulations. Without
	// one of these immediately after it, an unprefixed mention of the name
	// mid-conversation is just narration ("...the safebots project...") rather
	// than a command, and must NOT open the mic.
	var REQUEST_PHRASES = [
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
	var _REQUEST_PHRASE_RE_SOURCE = "(?:" + REQUEST_PHRASES.join("|") + ")";
	var _REQUEST_PHRASE_START_RE  = new RegExp("^" + _REQUEST_PHRASE_RE_SOURCE + "\\b", "i");

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
	var WAKE_WORD_REGEX = new RegExp(
		"\\b(?:" + optionalHeyLeadIn + "(?:" + syl1.join("|") + ")\\s+(?:" + syl2.join("|") + ")|" + requiredLeadIn + "(?:" + singleWords.join("|") + "))\\b",
		"i"
	);

	var WAKE_WORD_HEY_REGEX = new RegExp(
		"\\b(?:" + requiredHeyLeadIn + "(?:" + syl1.join("|") + ")\\s+(?:" + syl2.join("|") + ")|" + requiredLeadIn + "(?:" + singleWords.join("|") + "))\\b",
		"i"
	);

	var WAKE_WORD_BARE_REQUEST_REGEX = new RegExp(
		"\\b(?:" + syl1.join("|") + ")\\s+(?:" + syl2.join("|") + ")\\b[\\s,.:;!—-]*" + _REQUEST_PHRASE_RE_SOURCE + "\\b",
		"i"
	);

	// See "NOTE ON METAPHONE" above — not wired up yet.
	var metaphone = null;
	var _SAFEBOTS_META = null;

	// ── WakeWord ────────────────────────────────────────────────────────────

	function WakeWord() {
		Emitter.call(this);
		this.latestFinalAt       = null;
		this.transcriptBuffer    = [];
		this.transcriptBufferMap = new Map();
		this.wakeState           = null;   // 'listening' | null
		this.wakeEntries         = null;   // Set, created when listening starts
		this.wakeLastUpdate      = null;
		this.wakeStartedAt       = null;

		// Silence timeout, ported from the setInterval that used to live in
		// Pipeline.js's constructor: if a wake session goes >3s with no new
		// speech, wrap up whatever's been said instead of waiting forever for
		// a completion phrase the speaker may never say. wakeLastUpdate
		// refreshes on every wake-related utterance (see
		// processUtteranceWithWakeWord), so this is a SILENCE timeout, not an
		// absolute cap on the whole command -- checking wakeStartedAt instead
		// would cut off any command longer than 3s while the speaker is still
		// actively talking.
		var self = this;
		this._silenceInterval = setInterval(function () {
			self._checkWakeSilence();
		}, 3000);
	}
	WakeWord.prototype = Object.create(Emitter.prototype);
	WakeWord.prototype.constructor = WakeWord;

	/**
	 * Called every 3s. If we're mid wake-session and nothing new has come in
	 * for >3s, treat the latest wake entry's current text as the finished
	 * command -- but only once that entry is final (an interim result is
	 * still actively settling, not silence).
	 */
	WakeWord.prototype._checkWakeSilence = function () {
		if (this.wakeState !== 'listening') return;
		if (Date.now() - this.wakeLastUpdate <= 3000) return;

		var latestWakeEntry;
		for (var value of this.wakeEntries) {
			latestWakeEntry = value;
		}
		if (!latestWakeEntry || !latestWakeEntry.isFinal) return;

		var fullCommand = this.onWakeEndWord();
		this.emit('command', fullCommand);
	};

	/**
	 * Stop the silence-timeout interval. Call this when the tool holding a
	 * WakeWord instance is torn down, or the interval outlives it.
	 */
	WakeWord.prototype.destroy = function () {
		clearInterval(this._silenceInterval);
	};

	/**
	 * Feed one Web Speech API onresult event in. Builds a chunk from
	 * whatever's new in event.results and hands it to updateBuffer().
	 */
	WakeWord.prototype.procesTranscriptEvent = function (event) {
		var self = this;
		var interimTranscript = '';
		var finalTranscript = null;
		var confidence = null;

		if (self.latestFinalAt == null) {
			self.latestFinalAt = Date.now();
		}

		for (var i = event.resultIndex; i < event.results.length; ++i) {
			if (event.results[i].isFinal) {
				if (event.results[i][0].transcript.trim() != '') finalTranscript = event.results[i][0].transcript;
			} else {
				if (event.results[i][0].transcript.trim() != '') interimTranscript = event.results[i][0].transcript;
			}
			confidence = event.results[i][0].confidence;
		}

		var isFinal = finalTranscript != null;
		var prevFinalAt = self.latestFinalAt;
		if (isFinal) self.latestFinalAt = Date.now();
		var chunkToSend = finalTranscript || interimTranscript;
		if (!chunkToSend || chunkToSend.trim() == '') return;

		var chunkData = {
			isFinal: isFinal,
			text: (finalTranscript || interimTranscript).trim(),
			confidence: confidence,
			latestFinalAt: prevFinalAt,
			timestamp: Date.now(),
			eventTime: event.timeStamp,
			speaker: Q.Users.loggedInUserId()
		};

		return self.updateBuffer(chunkData);
	};

	/**
	 * Pull the ambient-safe leftover out of an entry after
	 * processUtteranceWithWakeWord has (possibly) marked it with
	 * __WAKESTART__/__WAKEEND__ sentinels: narration before __WAKESTART__ on
	 * a wake-start entry, narration after __WAKEEND__ on a wake-end entry.
	 * An entry that's neither (a pure mid-command entry) contributes nothing.
	 * @param {*} entry
	 */
	WakeWord.prototype._extractAmbientText = function (entry) {
		var text = entry.text || '';
		var parts = [];
		if (entry.isWakeUpStartEntry) {
			var before = text.match(/^([\s\S]*?)__WAKESTART__/);
			if (before && before[1].trim()) parts.push(before[1].trim());
		}
		if (entry.isWakeUpEndEntry) {
			var after = text.match(/__WAKEEND__([\s\S]*)$/);
			if (after && after[1].trim()) parts.push(after[1].trim());
		}
		return parts.join(' ');
	};

	/**
	 * Shape an ambient-safe leftover as the chunk object
	 * Q.Streams.Transcript.send() expects. Returns null for empty text so
	 * callers can skip forwarding a no-op chunk.
	 * @param {*} entry
	 * @param {string} text
	 */
	WakeWord.prototype._buildAmbientChunk = function (entry, text) {
		if (!text || !text.trim()) return null;
		return {
			transcript: text.trim(),
			isFinal: !!entry.isFinal,
			confidence: entry.confidence,
			latestFinalAt: entry.latestFinalAt
		};
	};

	/**
	 * Track this chunk's entry identity the same way the server's
	 * Streams.Transcript.process did (same latestFinalAt-keyed entry reuse,
	 * so interim growth of one utterance updates the SAME entry object
	 * rather than piling up duplicates), then run it through wake-word
	 * detection. Emits 'command' with the finished "Safebots, ..." request
	 * once a wake sequence completes, and returns whatever's left of this
	 * entry that ISN'T wake-command text (see _extractAmbientText), so a
	 * caller can forward genuine narration to the ambient transcript
	 * pipeline without also duplicating the wake command into it.
	 * @return {Object|null}
	 */
	WakeWord.prototype.updateBuffer = function (entry) {
		if (!entry.text) return null;

		var text = entry.text;
		if (this.transcriptBufferMap.has(entry.latestFinalAt)) {
			var entryToUpdate = this.transcriptBufferMap.get(entry.latestFinalAt);
			if (entryToUpdate.isWakeUp && this.wakeState != 'listening') {
				if (entryToUpdate.wakeUpTextLength == null) {
					entryToUpdate.wakeUpTextLength = entryToUpdate.text ? entryToUpdate.text.length : 0;
				}
				if (entryToUpdate.isWakeUpStartEntry && entryToUpdate.isWakeUpEndEntry) {
					entryToUpdate.text = text.slice(entryToUpdate.wakeUpTextLength);
				} else if (entryToUpdate.isWakeUpEndEntry) {
					entryToUpdate.text = text.slice(entryToUpdate.wakeUpTextLength);
				} else if (entryToUpdate.isWakeUpStartEntry) {
					entryToUpdate.text = text.slice(entryToUpdate.wakeUpTextLength);
				}
			} else if (entryToUpdate.isWakeUp && this.wakeState == 'listening' && entryToUpdate.wakeUpTextLength != null) {
				// Speaker started a new "wake" request in the same transcript
				// entry as the previous one (has to talk very fast for this).
				entryToUpdate.text = text.slice(entryToUpdate.wakeUpTextLength);
			} else {
				entryToUpdate.text = text;
			}

			if (entry.isFinal) {
                entryToUpdate.isFinal = true;
            }
            entry = entryToUpdate;
		} else {
			this.transcriptBufferMap.set(entry.latestFinalAt, entry);
			this.transcriptBuffer.push(entry);
		}

		var wakeRequest = this.processUtteranceWithWakeWord(entry);
		if (wakeRequest === false) {
			// No wake context at all -- the whole entry is ambient narration.
			return this._buildAmbientChunk(entry, entry.text);
		} else if (wakeRequest === true) {
			// Still consuming the command -- forward only a wake-start
			// entry's leading narration, if any; mid-command entries have
			// nothing ambient to contribute.
			return this._buildAmbientChunk(entry, this._extractAmbientText(entry));
		} else if (typeof wakeRequest == 'string') {
			if (entry.wakeUpTextLength != null) {
				entry.wakeUpTextLength = entry.wakeUpTextLength + text.length;
			}
			var ambientChunk = this._buildAmbientChunk(entry, this._extractAmbientText(entry));
			this.emit('command', wakeRequest);
			return ambientChunk;
		}
		return null;
	};

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
	WakeWord.prototype.detectWakeWord = function (transcript) {
		if (WAKE_WORD_HEY_REGEX.test(transcript)) {
			return true;
		}
		if (WAKE_WORD_BARE_REQUEST_REGEX.test(transcript)) {
			return true;
		}
		if (metaphone && this.detectWakeWordPhonetic(transcript)) {
			return true;
		}
		if (metaphone && this.detectWakeWordLevenshtein(transcript)) {
			return true;
		}
		return false;
	};

	/**
	 * Gate for a fuzzy (phonetic/Levenshtein) wake-word candidate spanning
	 * words[startIdx..endIdx]: allow it either because "hey"/"hi"
	 * immediately precedes it, or -- with no such lead-in -- because a
	 * request/imperative phrase immediately follows it. Mirrors the
	 * WAKE_WORD_HEY_REGEX / WAKE_WORD_BARE_REQUEST_REGEX split above, for
	 * candidates the exact regexes didn't catch.
	 */
	WakeWord.prototype._wakeWordContextOk = function (words, startIdx, endIdx) {
		var before = startIdx > 0 ? words[startIdx - 1].replace(/[^a-z]/gi, '') : '';
		if (/^(?:hey|hi)$/i.test(before)) return true;
		var window = words.slice(endIdx + 1, endIdx + 7).join(' ');
		return _REQUEST_PHRASE_START_RE.test(window);
	};

	WakeWord.prototype.detectWakeWordPhonetic = function (transcript) {
		var words = transcript.toLowerCase().split(/\s+/);
		var i;
		for (i = 0; i < words.length; i++) {
			if (metaphone(words[i]) === _SAFEBOTS_META && this._wakeWordContextOk(words, i, i)) return true;
		}
		for (i = 0; i < words.length - 1; i++) {
			var joined = words[i] + words[i + 1];
			if (metaphone(joined) === _SAFEBOTS_META && this._wakeWordContextOk(words, i, i + 1)) return true;
		}
		return false;
	};

	WakeWord.prototype.levenshtein = function (a, b) {
		if (!a.length) return b.length;
		if (!b.length) return a.length;
		var matrix = [];
		var i, j;
		for (i = 0; i <= b.length; i++) matrix[i] = [i];
		for (j = 0; j <= a.length; j++) matrix[0][j] = j;
		for (i = 1; i <= b.length; i++) {
			for (j = 1; j <= a.length; j++) {
				if (b[i - 1] === a[j - 1]) matrix[i][j] = matrix[i - 1][j - 1];
				else matrix[i][j] = Math.min(
					matrix[i - 1][j - 1] + 1,
					matrix[i][j - 1] + 1,
					matrix[i - 1][j] + 1
				);
			}
		}
		return matrix[b.length][a.length];
	};

	WakeWord.prototype.detectWakeWordLevenshtein = function (transcript) {
		var target = _WAKE_WORD;
		var words = transcript.toLowerCase().split(/\s+/);
		var i;
		for (i = 0; i < words.length; i++) {
			if (this.levenshtein(words[i], target) <= 2 && this._wakeWordContextOk(words, i, i)) return true;
		}
		for (i = 0; i < words.length - 1; i++) {
			var joined = words[i] + words[i + 1];
			if (this.levenshtein(joined, target) <= 2 && this._wakeWordContextOk(words, i, i + 1)) return true;
		}
		return false;
	};

	WakeWord.prototype.extractCommandAfterWakeWord = function (transcript) {
		// Find where the wake word matched — replace variants with a marker, then split.
		var marked = transcript.replace(WAKE_WORD_REGEX, '__WAKESTART__');

		var parts = marked.split('__WAKESTART__');
		// Everything after the wake word (and past any leading punctuation/whitespace).
		return {
			marked: marked,
			textBefore: parts[0],
			command: parts.slice(1).join(' ').replace(/^[\s,.:;]+/, '').trim()
		};
	};

	WakeWord.prototype.processUtteranceWithWakeWord = function (transcriptEntry) {
		var transcript = transcriptEntry.text;

		// Are we already listening for a follow-up?
		if (this.wakeState === 'listening') {
			if (!this.wakeEntries.has(transcriptEntry)) {
				this.wakeEntries.add(transcriptEntry);
				transcriptEntry.isWakeUp = true;
			}

			this.wakeLastUpdate = Date.now();

			if (transcriptEntry.isWakeUpStartEntry) {
				var parsedParts = this.extractCommandAfterWakeWord(transcript);
				transcriptEntry.text = parsedParts.marked;
			}

			// Check for completion marker.
			var completionCheck = this.isCompletionMarker(transcriptEntry.text);
			if (completionCheck.isCompletion) {
				transcriptEntry.text = completionCheck.marked;
				transcriptEntry.isWakeUpEndEntry = true;
				return this.onWakeEndWord();
			} else {
				var fullCommand = 'Safebots, ' + this.getFullCommand().replace(/__WAKESTART__.*?__WAKEEND__/s, "");
				this.emit('pendingCommand', fullCommand);
			}
			// No completion yet, keep accumulating (with timeout — see below).
			return true; // consumed
		}
		// Not listening — check for wake word.
		if ((!transcriptEntry.isWakeUp || (transcriptEntry.isWakeUp && transcriptEntry.wakeUpTextLength)) && this.detectWakeWord(transcript)) {
			this.wakeEntries = new Set();
			if (!this.wakeEntries.has(transcriptEntry)) {
				this.wakeEntries.add(transcriptEntry);
			}
			transcriptEntry.isWakeUp = true;
			transcriptEntry.isWakeUpStartEntry = true;
			this.wakeState = 'listening';
			var startParts = this.extractCommandAfterWakeWord(transcript);

			transcriptEntry.text = startParts.marked;
			this.wakeStartedAt = Date.now();
			this.wakeLastUpdate = Date.now();

			this.emit('wakeStart', transcript);

			// Check if wake and completion arrived in the same utterance.
			var startCompletionCheck = this.isCompletionMarker(transcriptEntry.text);
			if (startCompletionCheck.isCompletion) {
				transcriptEntry.text = startCompletionCheck.marked;
				transcriptEntry.isWakeUpEndEntry = true;
				return this.onWakeEndWord();
			}
			return true; // consumed
		}

		return false; // no wake context, process normally
	};

	WakeWord.prototype.getFullCommand = function () {
		// Collect each entry's extracted contribution and join only the
		// non-empty ones with a single space. Unconditionally prepending a
		// separator per entry means an entry that contributes nothing --
		// e.g. the wake-word entry itself, once "Hey Safebots" is stripped
		// out -- still adds a bare separator, so a run of such entries
		// degenerates into pure noise with the real command text buried or
		// lost entirely.
		var parts = [];
		for (var wakeEntry of this.wakeEntries) {
			var piece;
			if (wakeEntry.isWakeUpStartEntry && wakeEntry.isWakeUpEndEntry) {
				var match = wakeEntry.text.match(/__WAKESTART__(.*?)__WAKEEND__/s);
				piece = match ? match[1] : '';
			} else if (wakeEntry.isWakeUpStartEntry) {
				var afterMatch = wakeEntry.text.match(/__WAKESTART__(.*)$/s);
				piece = afterMatch ? afterMatch[1] : '';
			} else if (wakeEntry.isWakeUpEndEntry) {
				var beforeMatch = wakeEntry.text.match(/^(.*?)__WAKEEND__/s);
				piece = beforeMatch ? beforeMatch[1] : '';
			} else { //!wakeEntry.isWakeUpStartEntry && !wakeEntry.isWakeUpEndEntry
				piece = wakeEntry.text;
			}
			piece = (piece || '').trim();
			if (piece) parts.push(piece);
		}
		return parts.join(' ');
	};

	WakeWord.prototype.onWakeEndWord = function () {
		this.wakeState = null;

		var fullCommand = this.getFullCommand();
		this.emit('wakeEnd', fullCommand);

		this.wakeStartedAt = null;
		this.wakeEntries = null;
		this.wakeLastUpdate = null;

		return 'Safebots, ' + fullCommand;
	};

	WakeWord.prototype.isCompletionMarker = function (text) {
		var matches = [...text.matchAll(_COMPLETION_MARKER_RE)];

		var result = null;
		var command = null;
		if (matches.length) {
			var last = matches[matches.length - 1];
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
		};
	};

	return WakeWord;
}));
