"use strict";

/**
 * AI/classes/AI/Transcript.js
 *
 * The AI side of transcript ingestion. Streams owns the session, the
 * transcription adapter, and ingestion (Streams.Transcript.process). This layer
 * subscribes to that pass and adds what only the AI plugin owns: TTS cue audio
 * for the durable record, the AI event bus, the LLM pipeline for non-control
 * narration, and topic-shift posting under the AI namespace.
 *
 * AI.listen wires afterStreams onto Streams.Transcript's 'processed' event, so
 * this runs right after Streams finishes each final utterance.
 *
 * @class AI.Transcript
 * @static
 */
var Q = require('Q');
var Session = Q.require('Streams/Transcript/Session');
var Pipeline = Q.require('AI/Pipeline');
var VetoQueue = Q.require('AI/VetoQueue');
var CueAudio = Q.require('AI/CueAudio');
var transcriptEmitter = Q.require('Streams/TranscriptEmitter').transcriptEmitter;

function Transcript() {}


// Set of intents that benefit from rolling-context (recent3) fallback because
// the user may pause between the trigger verb and the parameter:
//   "go to the … pricing slide"          → slide/navigate {query: 'pricing'}
//   "rewind … thirty seconds"            → video/seek/relative {time}
//   "highlight … the third bar"          → highlight {elementId}
//   "generate an image of … a cat"       → image/generate {prompt}
// Simple intents without captures (slide/next, video/pause, zoom/in, etc.)
// are self-contained single utterances — pass 2 should not match them, or
// stale buffer entries trigger false positives ("next slide" lingering in
// the buffer matching a new "previous slide" utterance).
var CAPTURE_INTENTS = new Set([
    'slide/navigate',
    'video/seek',
    'video/seek/relative',
    'highlight',
    'image/generate',
    'tool/generate',
    'stream/create',
    'stream/grantAccess',
    'stream/revokeAccess'
]);

/**
 * Run the AI layer after Streams has ingested a final utterance. Subscribed to
 * Streams.Transcript's 'processed' event in AI.listen.
 *
 * @method afterStreams
 * @static
 * @param {Object} session
 * @param {Object} result   { isControl, entry, ordinal } from Streams.Transcript
 * @param {Object} AI
 * @param {Object} Q
 * @param {Object} Users
 */
Transcript.process = async function (session, chunk, AI, Q, Users) {
    if (!chunk.isFinal || !chunk.transcript || !chunk.transcript.trim()) return;

    var text = chunk.transcript.trim();
    var entry = {
        text:    text,
        ts:      Date.now(),
        relSec:  Session.relSec(session),
        speaker: chunk.speaker || session.userId,
        isFinal: true,
    };
    session.transcriptBuffer.push(entry);
    if (session.transcriptBuffer.length > 8) session.transcriptBuffer.shift();

    Transcript._resolveDisplayName(session, entry.speaker, Q);

    // Rolling context — catches split control commands ("go to the … roadmap slide")
    var recent3 = session.transcriptBuffer.slice(-3).map(function (e) { return e.text; }).join(' ');

    // 1) Classifier — instant, zero cost. Runs first so the flag is
    //    available when we write the durable message + VTT cue.
    var isControl = false;
    if (session.role === 'host' && session.modes.navigation !== false) {
        var classifyState = {
            slideIndex:      session.slideIndex,
            revealIndex:     session.revealIndex,
            zoomScale:       session.zoomScale,
            userId:          session.userId,
            publisherId:     session.publisherId,
            streamName:      session.streamName,
            toolStreamName:  session.toolStreamName || null,
            toolPublisherId: session.userId,
            // Full session reference for handlers that need session-internal
            // fields (sessionStartMs for relSec, transcriptFile for VTT cues,
            // _displayNames for speaker tags). ControlClassifier ignores this
            // — only command handlers reach in via state.session.
            session:         session,
            sessionStartMs:  session.sessionStartMs,
            Q:               Q,
            Users:           Users,
        };
        var proxy = session.publisherId ? StreamProxy.make(session, Q, Users) : null;
        if (proxy && session.classifier.classify(recent3, proxy, classifyState)) {
            isControl = true;
        }
    }

    // 2) Durable transcript message + VTT cue
    if (session.publisherId && session.streamName) {
        Session.postMessage(Q, {
            publisherId:  session.publisherId,
            streamName:   session.streamName,
            byUserId:     entry.speaker || session.userId,
            type:         'Media/presentation/transcript',
            content:      entry.text,
            instructions: JSON.stringify({
                speaker:    entry.speaker || session.userId,
                relSec:     entry.relSec,
                isFinal:    true,
                confidence: chunk.confidence || 1,
                control:    isControl || undefined,
            }),
        }, function (err, message) {
            var ordinal = (!err && message) ? message.fields.ordinal : null;
            transcriptEmitter.emitChunk(session, entry, ordinal, { control: isControl });
            if (ordinal != null && session.transcriptFile) {
                CueAudio.generate(session, entry, ordinal, Q);
            }
        });
    } else {
        transcriptEmitter.emitChunk(session, entry, null, { control: isControl });
    }

    // 3) Chat-style transcript post — each person posts under their own userId
    if (session.modes.transcription !== false && session.publisherId && session.streamName) {
        Session.postMessage(Q, {
            publisherId:  session.publisherId,
            streamName:   session.streamName,
            byUserId:     entry.speaker || session.userId,
            type:         'Streams/chat/message',
            content:      entry.text,
            instructions: JSON.stringify({
                isTranscript: true,
                relSec:       entry.relSec,
                control:      isControl || undefined,
            }),
        });
    }

    AI.emit('transcript',
        session.userId, session.publisherId, session.streamName,
        Object.assign({}, result.entry));

    // LLM pipeline — only for non-control narration, with composition on, host.
    if (!result.isControl && session.role === 'host' && session.modes.composition !== false) {
        await Transcript._processChunk(session, result.entry.text, AI, Q, Users);
    }
};

/**
 * Drive the LLM pipeline for a non-control utterance.
 * @method _processChunk
 * @private
 * @static
 */
Transcript._processChunk = async function (session, text, AI, Q, Users) {
    if (!session.pipeline) {
        session.pipeline = new Pipeline({
            Q: Q,
            session: session,
            emitToUser: function (userId, event, data) {
                Users.Socket.emitToUser(userId, event, data);
            },
            onTopicChange: function (fromTopic, toTopic) {
                Transcript._onTopicChange(session, fromTopic, toTopic, AI, Q, Users);
            }
        });
    }

    var result = null;
    try {
        result = await session.pipeline.run(text);
    } catch (e) {
        Users.Socket.emitToUser(session.userId, 'AI/error', {
            message: e.message, code: 500
        });
        return;
    }
    if (!result) return;

    if (result.action === 'ephemeral') {
        if (session.publisherId && result.ephemeralType) {
            Users.Socket.emitToUser(session.userId, 'AI/ephemeral', {
                publisherId: session.publisherId,
                streamName:  session.streamName,
                type:        result.ephemeralType,
                payload:     result.ephemeralPayload || {}
            });
        }
        return;
    }
    if (result.action === 'coaching' || result.routing === 'privateOnly') {
        Users.Socket.emitToUser(session.userId, 'AI/coaching', {
            text:      result.coachingText,
            sourceUri: result.sourceUri
        });
        return;
    }
    if (result.action === 'propose') {
        AI.emit('proposal',
            session.userId, session.publisherId, session.streamName, result);
        VetoQueue.enqueue(session, result, AI, Q, Users);
    }
};

/**
 * Topic-shift callback wired into the pipeline. The shift is detected by the
 * LLM, so it posts under the AI namespace — AI/topic. The VTT NOTE marker still
 * goes through the shared TranscriptEmitter.
 *
 * @method _onTopicChange
 * @private
 * @static
 */
Transcript._onTopicChange = function (session, fromTopic, toTopic, AI, Q, Users) {
    Q.log && Q.log('AI: topic shift', fromTopic, '->', toTopic);
    var topicRelSec = Session.relSec(session);
    transcriptEmitter.emitTopicChange(session, fromTopic, toTopic, topicRelSec);
    AI.emit('topicChange',
        session.userId, session.publisherId, session.streamName,
        { from: fromTopic, to: toTopic,
          isOwnLivestream: !!session.isOwnLivestream }
    );
    Users.Socket.emitToUser(session.userId, 'AI/topicChange', {
        from: fromTopic, to: toTopic, relSec: topicRelSec
    });
    if (session.publisherId && session.streamName) {
        Session.postMessage(Q, {
            publisherId:  session.publisherId,
            streamName:   session.streamName,
            byUserId:     session.userId,
            type:         'Media/presentation/topic',
            instructions: JSON.stringify({ from: fromTopic, to: toTopic, relSec: topicRelSec }),
        });
    }
};

module.exports = Transcript;