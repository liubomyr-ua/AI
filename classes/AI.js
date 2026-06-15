"use strict";
/*jshint node:true */
/**
 * AI plugin
 * @module AI
 * @main AI
 */
var Q = require('Q');

/**
 * Static methods for the AI plugin.
 * @class AI
 * @static
 */
function AI() {}
module.exports = AI;

Q.makeEventEmitter(AI);

// Lazily loaded after Q is ready to require plugins.
var Session, Transcript, VetoQueue, CardCommit, AI_Transcription;
var transcriptEmitter = null;  // hoisted at first AI.listen() — Streams plugin must be loaded first

/**
 * Start node-side listeners for the AI plugin.
 *
 * Opens the `/Q` socket namespace handlers that drive the AI pipeline:
 * transcription session lifecycle, transcript ingestion, control commands,
 * proposal veto, card replay, narration.
 *
 * Mirrors {{#crossLink "Users/listen:method"}}{{/crossLink}} — all the
 * wiring happens here, and the per-event handlers delegate to focused
 * classes under AI/classes/AI/*.
 *
 * Idempotent — safe to call more than once.
 * Call after Users.Socket.listen() so the /Q namespace exists:
 *
 *   Q.init();
 *   Users.Socket.listen();
 *   Media.listen();
 *   AI.listen();
 *
 * @method listen
 * @static
 */
AI.listen = function () {
    if (AI.listen.result) return AI.listen.result;

    Session          = require('./AI/Session');
    Transcript       = require('./AI/Transcript');
    VetoQueue        = require('./AI/VetoQueue');
    CardCommit       = require('./AI/CardCommit');
    AI_Transcription = require('./AI/Transcription');
    transcriptEmitter = require('../../Streams/classes/Streams/TranscriptEmitter').transcriptEmitter;
    var Users        = Q.require('Users');

    // Get the socket.io server — Users.Socket.listen() is idempotent.
    var socket = Users.Socket.listen();
    var nsp = socket.io.of('/Q');

    nsp.on('connection', function (client) {
        if (client._aiRegistered) return;
        client._aiRegistered = true;

        var userId = client.capability && client.capability.userId;

        // ── Session control ─────────────────────────────────────────────

        client.on('AI/session/modes', function (data) {
            var session = Session.get(client.id);
            if (!session || !data) return;
            if (data.composition   !== undefined) session.modes.composition   = !!data.composition;
            if (data.navigation    !== undefined) session.modes.navigation    = !!data.navigation;
            if (data.transcription !== undefined) session.modes.transcription = !!data.transcription;
            Q.log && Q.log('AI: modes updated', session.modes);
        });

        client.on('AI/transcription/session/start', function (data) {
            if (!userId) return;
            var session = Session.create(client, userId, data, Q);
            AI._openTranscription(session, Users);
            AI._afterSessionStart(session, data, Users);
        });

        client.on('AI/transcription/session/chunk', function (buffer) {
            var session = Session.get(client.id);
            if (session && session.transcription) session.transcription.send(buffer);
        });

        client.on('AI/transcription/session/stop',  function () {
            var session = Session.get(client.id);
            if (session) Session.close(session);
        });

        client.on('AI/transcription/session/abort', function () {
            var session = Session.get(client.id);
            if (session) Session.close(session);
        });

        // ── Transcript / pipeline entry point ──────────────────────────

        // Single handler for all utterance sources — WebSpeech, Deepgram echo,
        // typed text. Shape: { transcript, isFinal, confidence, speaker }.
        // Interim chunks (isFinal:false) are silently dropped by
        // Transcript.process — only finals run through the pipeline.
        client.on('Streams/utterance', function (data) {
            var session = Session.get(client.id);
            if (!session) return;
            Transcript.process(session, data, AI, Q, Users);
        });

        // ── Navigation commands ────────────────────────────────────────

        client.on('Media/presentation/command', function (data) {
            var session = Session.get(client.id);
            if (!session || !data || !data.intent) return;
            AI._navCommand(session, data);
        });

        // ── Card replay (host clicks historical card in chat) ──────────

        client.on('AI/card/replay', function (data) {
            var session = Session.get(client.id);
            if (!session) return;
            CardCommit.replay(session, data, Users);
        });

        // ── Narration mode (script playback) ───────────────────────────

        // data: { lines: [...], msPerLine: 3000 }   host only
        client.on('AI/stream/narrate', function (data) {
            var session = Session.get(client.id);
            if (!session || session.role !== 'host') return;
            var lines     = (data && Array.isArray(data.lines)) ? data.lines : [];
            var msPerLine = (data && data.msPerLine) || 3000;
            if (!lines.length) return;
            session.mode = 'narration';
            var i = 0;
            (function feedNext() {
                if (i >= lines.length) return;
                var line = lines[i++].trim();
                if (line) {
                    Transcript.process(session, {
                        transcript: line, isFinal: true, confidence: 1, speaker: userId
                    }, AI, Q, Users);
                }
                setTimeout(feedNext, msPerLine);
            })();
        });

        // ── Veto actions ───────────────────────────────────────────────

        client.on('AI/veto/commit', function (data) {
            var session = Session.get(client.id);
            if (session) VetoQueue.commit(session, data && data.proposalId, AI, Q, Users);
        });

        client.on('AI/veto/cancel', function (data) {
            var session = Session.get(client.id);
            if (session) VetoQueue.cancel(session, data && data.proposalId, Users);
        });

        // ── Tool committed (generated tool was shown on screen) ────────

        client.on('AI/tool/committed', function (data) {
            var session = Session.get(client.id);
            if (!session || !session.publisherId || !session.streamName) return;
            var toolName = data && data.toolName;
            if (!toolName) return;
            AI._postToolCommit(session, toolName);
        });

        // ── Disconnect ─────────────────────────────────────────────────

        client.on('disconnect', function () {
            var session = Session.get(client.id);
            if (!session) return;
            Session.close(session);
            transcriptEmitter.emitSessionEnd(session);
            AI.emit('sessionEnd', userId,
                session.publisherId, session.streamName, {
                    transcriptFile: session.transcriptFile,
                    chunkCount:     session.transcriptBuffer.length
                });
            if (session.publisherId && session.streamName) {
                Session.postMessage(Q, {
                    publisherId: session.publisherId,
                    streamName:  session.streamName,
                    byUserId:    userId,
                    type:        'Media/presentation/end',
                    instructions: JSON.stringify({
                        relSec:                 Session.relSec(session),
                        transcriptMessageCount: session.transcriptBuffer.length,
                    }),
                });
            }
            Session.remove(client.id);
            Q.log && Q.log('AI session ended', userId, client.id);
        });
    });

    return AI.listen.result = { socket: true };
};

// ── Private helpers used by AI.listen ───────────────────────────────────────

AI._openTranscription = function (session, Users) {
    var provider = (Q.Config && Q.Config.get(['AI', 'transcription', 'provider'], null))
        || (Q.Config && Q.Config.get(['AI', 'deepgram', 'key'], null) ? 'deepgram' : null);
    if (!provider) return;

    var adapter = AI_Transcription.create(provider);
    if (!adapter) {
        Q.log && Q.log('AI: unknown transcription provider:', provider);
        return;
    }
    session.transcription = adapter;
    adapter.open(session, {
        Q: Q,
        onUtterance: function (chunk) {
            // Interim: echo for live caption display.
            // Final: Transcript.process re-emits with relSec after pipeline runs.
            if (!chunk.isFinal) {
                Users.Socket.emitToUser(session.userId, 'Streams/utterance', chunk);
            }
            Transcript.process(session, chunk, AI, Q, Users);
        },
        onError: function (e) {
            Users.Socket.emitToUser(session.userId, 'AI/error', {
                message: (adapter.platform || 'Transcription') + ' error: ' + e.message,
                code: 502
            });
        }
    });
};

AI._afterSessionStart = function (session, data, Users) {
    transcriptEmitter.emitSessionStart(session, Q);
    AI.emit('sessionStart', session.userId, session.publisherId, session.streamName, {
        role: session.role, lang: session.lang, ts: session.sessionStartMs
    });
    if (session.publisherId && session.streamName) {
        Session.postMessage(Q, {
            publisherId: session.publisherId, streamName: session.streamName,
            byUserId:    session.userId,
            type:        'Media/presentation/start',
            instructions: JSON.stringify({
                role: session.role, lang: session.lang, mode: session.mode
            }),
        });
    }
};

AI._navCommand = function (session, data) {
    if (data.slideIndex  != null) session.slideIndex  = data.slideIndex;
    if (data.revealIndex != null) session.revealIndex = data.revealIndex;
    if (!session.publisherId || !session.streamName) return;

    var intent = data.intent || '';
    var isSlide  = intent === 'slide/navigate'  || intent.indexOf('slide/')  === 0;
    var isReveal = intent === 'reveal/navigate' || intent.indexOf('reveal/') === 0;
    if (!isSlide && !isReveal) return;

    var relSec = data.relSec || Session.relSec(session);

    if (isSlide) {
        var slideInstr = JSON.stringify({
            index:  session.slideIndex,
            relSec: relSec,
            intent: intent,
            query:  data.query || undefined
        });
        Session.postMessage(Q, {
            publisherId:  session.publisherId,
            streamName:   session.streamName,
            byUserId:     session.userId,
            type:         'Media/presentation/slide',
            instructions: slideInstr,
        }, function (err, message) {
            if (!err && message) {
                transcriptEmitter._appendVttEventNote(
                    session, 'Media/presentation/slide',
                    message.fields.ordinal, slideInstr, Q, message.fields.sentTime
                );
            }
        });
        return;
    }

    // Reveal — same shape, different type. Durable record so the VTT
    // chapter markers carry within-slide reveal advances too.
    var revealInstr = JSON.stringify({
        index:  session.revealIndex,
        relSec: relSec,
        intent: intent
    });
    Session.postMessage(Q, {
        publisherId:  session.publisherId,
        streamName:   session.streamName,
        byUserId:     session.userId,
        type:         'Media/presentation/reveal',
        instructions: revealInstr,
    }, function (err, message) {
        if (!err && message) {
            transcriptEmitter._appendVttEventNote(
                session, 'Media/presentation/reveal',
                message.fields.ordinal, revealInstr, Q, message.fields.sentTime
            );
        }
    });
};

AI._postToolCommit = function (session, toolName) {
    var relSec    = Session.relSec(session);
    var toolInstr = JSON.stringify({ toolName: toolName, relSec: relSec });
    Session.postMessage(Q, {
        publisherId:  session.publisherId,
        streamName:   session.streamName,
        byUserId:     session.userId,
        type:         'Media/presentation/tool/show',
        instructions: toolInstr,
    }, function (err, message) {
        if (!err && message) {
            transcriptEmitter._appendVttEventNote(
                session,
                'Media/presentation/tool/show',
                message.fields.ordinal,
                toolInstr, Q,
                message.fields.sentTime
            );
        }
    });
};

/**
 * Events emitted on AI (Node-side, for server plugins):
 *
 *   AI.on('transcript',   function (userId, publisherId, streamName, chunk) {})
 *   AI.on('topicChange',  function (userId, publisherId, streamName, evt) {})
 *   AI.on('proposal',     function (userId, publisherId, streamName, proposal) {})
 *   AI.on('commit',       function (userId, publisherId, streamName, proposal) {})
 *   AI.on('sessionStart', function (userId, publisherId, streamName, data) {})
 *   AI.on('sessionEnd',   function (userId, publisherId, streamName, data) {})
 *
 * Socket events delivered to clients on the /Q namespace:
 *
 *   Streams/utterance  { transcript, isFinal, confidence, speaker, relSec }
 *   AI/veto/show       { proposal, windowMs }                     host only
 *   AI/veto/commit     { proposalId }
 *   AI/veto/cancel     { proposalId }
 *   AI/coaching        { text, sourceUri }                        host only
 *   AI/proposal/show   { proposalId, visualizationType, visualizationData,
 *                        streamType, citations }
 *   AI/error           { message, code }
 */

/* * * */
