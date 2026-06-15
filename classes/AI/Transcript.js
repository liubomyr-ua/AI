"use strict";

/**
 * @module AI
 */

var Session = require('./Session');
var Pipeline = require('./Pipeline');
var VetoQueue = require('./VetoQueue');
var StreamProxy = require('./StreamProxy');
var CueAudio = require('./CueAudio');
var transcriptEmitter = require('../../../Streams/classes/Streams/TranscriptEmitter').transcriptEmitter;

/**
 * Transcript ingestion pipeline.
 * One static entry point — {{#crossLink "AI.Transcript/process:method"}}{{/crossLink}} —
 * handles a final utterance from any source (browser WebSpeech, Deepgram
 * adapter, typed text). Runs classifier, posts durable records, fans out
 * to clients, and routes to the LLM pipeline if not a control command.
 *
 * @class AI.Transcript
 * @static
 */
function Transcript() {}

/**
 * Process one final transcript chunk.
 * @method process
 * @static
 * @param {Object} session
 * @param {Object} chunk    { transcript, isFinal, confidence, speaker }
 * @param {Object} AI       AI module (event emitter)
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
        Object.assign({}, entry)
    );
    Users.Socket.emitToUser(session.userId, 'Streams/utterance', {
        transcript: entry.text,
        isFinal:    true,
        confidence: chunk.confidence,
        speaker:    entry.speaker,
        relSec:     entry.relSec,
    });

    // 4) LLM pipeline — only if not a control command + composition mode on + host
    if (!isControl && session.role === 'host' && session.modes.composition !== false) {
        await Transcript._processChunk(session, text, AI, Q, Users);
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
            session: {
                role:        session.role,
                publisherId: session.publisherId,
                streamName:  session.streamName,
                userId:      session.userId,
                socket:      session.socket
            },
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
 * Topic-shift callback wired into the pipeline.
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

/**
 * Resolve and cache a speaker's display name for VTT <v> tags.
 * Direct DB query — same logic as PHP Streams_Avatar::fetch with the
 * user's own publisherId.
 * @method _resolveDisplayName
 * @private
 * @static
 */
Transcript._resolveDisplayName = function (session, speakerUserId, Q) {
    if (!speakerUserId || !session._displayNames) return;
    if (speakerUserId in session._displayNames) return;
    // Placeholder prevents duplicate fetches under concurrent utterances
    session._displayNames[speakerUserId] = speakerUserId;
    try {
        var Streams = Q.require('Streams');
        var Avatar  = Streams && Streams.Avatar;
        if (Avatar && Avatar.SELECT) {
            Avatar.SELECT('*')
                .where({ toUserId: ['', speakerUserId], publisherId: speakerUserId })
                .limit(1)
                .execute(function (err, rows) {
                    if (err || !rows || !rows.length) return;
                    var f = rows[0].fields;
                    var name = [f.firstName, f.lastName].filter(Boolean).join(' ').trim()
                            || f.username || speakerUserId;
                    if (name && session._displayNames) {
                        session._displayNames[speakerUserId] = name;
                    }
                });
        }
    } catch (e) {
        // Streams.Avatar not available — userId stays as fallback
    }
};

module.exports = Transcript;
