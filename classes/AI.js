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
var Transcript, VetoQueue, CardCommit, Session, StreamsTranscript;
var transcriptEmitter = null;  // hoisted at first AI.listen() — Streams plugin must be loaded first

/**
 * Start node-side AI listeners.
 *
 * Streams now owns the transcription session, the audio adapter, and
 * Streams/utterance ingestion (see Streams.listen). AI subscribes to that work:
 * it runs its LLM pipeline on each non-control utterance, and re-broadcasts
 * session lifecycle on its own event bus. The only client events it still wires
 * are its own — veto, card replay, narration.
 *
 * Idempotent. Call after Streams.listen() so the session lifecycle and
 * 'processed' event exist:
 *
 *   Q.init();
 *   Users.Socket.listen();
 *   Streams.listen();
 *   Media.listen();
 *   AI.listen();
 *
 * @method listen
 * @static
 */
AI.listen = function () {
    if (AI.listen.result) return AI.listen.result;

    Transcript        = require('./AI/Transcript');
    VetoQueue         = require('./AI/VetoQueue');
    CardCommit        = require('./AI/CardCommit');
    Session           = require(Q.PLUGINS_DIR + '/Streams/classes/Streams/Transcript/Session');
    StreamsTranscript = require(Q.PLUGINS_DIR + '/Streams/classes/Streams/Transcript');
    transcriptEmitter = require(Q.PLUGINS_DIR + '/Streams/classes/Streams/TranscriptEmitter').transcriptEmitter;
    var Users         = Q.require('Users');

    // ── Subscribe to Streams ingestion (once) ──────────────────────────

    // Every final utterance: run the AI pipeline for non-control narration.
    StreamsTranscript.on('processed', function (session, result, Q, Users) {
        Transcript.afterStreams(session, result, AI, Q, Users);
    });

    // Re-broadcast session lifecycle on the AI event bus for server plugins.
    transcriptEmitter.on('sessionStart', function (evt) {
        var s = Session.get(evt.sessionId);
        AI.emit('sessionStart', s && s.userId, evt.publisherId, evt.streamName,
            { role: evt.role, lang: evt.lang, ts: evt.ts });
    });
    transcriptEmitter.on('sessionEnd', function (evt) {
        var s = Session.get(evt.sessionId);
        AI.emit('sessionEnd', s && s.userId, evt.publisherId, evt.streamName,
            { transcriptFile: evt.transcriptFile, chunkCount: evt.chunkCount });
    });

    // ── AI-only client events ──────────────────────────────────────────

    var pubHost = Q.Config.get(['Streams', 'node', 'host'], Q.Config.get(['Q', 'node', 'host'], null));
    var pubPort = Q.Config.get(['Streams', 'node', 'port'], Q.Config.get(['Q', 'node', 'port'], null));
   
    if (pubHost === null) {
        throw new Q.Exception("Streams: Missing config field: Streams/node/host");
    }
    if (pubPort === null) {
        throw new Q.Exception("Streams: Missing config field: Streams/node/port");
    }

    /**
     * @property socketServer
     * @type {SocketNamespace}
     * @private
     */
    var socket = Users.Socket.listen({
        host: pubHost,
        port: pubPort,
        https: Q.Config.get(['Q', 'node', 'https'], false) || {},
    });

    var nsp = socket.io.of('/Q');

    // ── Server-side audio transcription (Deepgram / AssemblyAI) ─────────
    // Only when a provider is configured. The browser ships audio up; the
    // adapter relays each transcript back down on AI/transcription/result.
    // The client surfaces that as onResult and Streams emits the single
    // upstream Streams/utterance, which is the one processing path — so this
    // relays and never calls process() itself. Inert on browser-native.
    var sttProvider = (Q.Config && Q.Config.get(['AI', 'transcription', 'provider'], null))
        || (Q.Config && Q.Config.get(['AI', 'transcription', 'deepgram', 'key'], null) ? 'deepgram' : null);

    if (sttProvider) {
        var AI_Transcription = require('./AI/Transcription');

        transcriptEmitter.on('sessionStart', function (evt) {
            var session = Session.get(evt.sessionId);
            if (!session || session.transcription) return;
            var adapter = AI_Transcription.create(sttProvider);
            if (!adapter) return;
            session.transcription = adapter;
            adapter.open(session, {
                Q: Q,
                onUtterance: function (chunk) {
                    Users.Socket.emitToUser(session.userId, 'AI/transcription/result', chunk);
                },
                onError: function (e) {
                    Users.Socket.emitToUser(session.userId, 'AI/error', {
                        message: (adapter.platform || 'Transcription') + ' error: ' + (e && e.message),
                        code: 502
                    });
                }
            });
        });

        nsp.on('connection', function (client) {
            client.on('AI/transcription/session/chunk', function (buffer) {
                var session = Session.get(client.id);
                if (session && session.transcription) session.transcription.send(buffer);
            });
        });
    }

    nsp.on('connection', function (client) {
        if (client._aiRegistered) return;
        client._aiRegistered = true;

        var userId = client.capability && client.capability.userId;

        // Veto actions
        client.on('AI/veto/commit', function (data) {
            var session = Session.get(client.id);
            if (session) VetoQueue.commit(session, data && data.proposalId, AI, Q, Users);
        });
        client.on('AI/veto/cancel', function (data) {
            var session = Session.get(client.id);
            if (session) VetoQueue.cancel(session, data && data.proposalId, Users);
        });

        // Card replay (host clicks a historical card in chat)
        client.on('AI/card/replay', function (data) {
            var session = Session.get(client.id);
            if (session) CardCommit.replay(session, data, Users);
        });

        // Narration mode (script playback) — feeds lines as utterances into the
        // Streams pass, which fires 'processed' and runs the pipeline.
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
                    StreamsTranscript.process(session, {
                        transcript: line, isFinal: true, confidence: 1, speaker: userId
                    }, Q, Users);
                }
                setTimeout(feedNext, msPerLine);
            })();
        });
        client.on('disconnect', function () {
            var session = Session.get(client.id);
            if (!session) return;

            // Mark the session disconnected and start the grace timer. All cleanup
            // (transcript emit, sessionEnd event, durable end-message, removal)
            // moves into the deferred path so a reconnecting client picks up
            // where it left off. If grace expires without reconnect, _finalizeEnd
            // runs the full teardown that used to live here.
            Session.markDisconnected(session, Q, function _finalizeEnd() {
                transcriptEmitter.emitSessionEnd(session);
                AI.emit('sessionEnd', userId,
                    session.publisherId, session.streamName, {
                    transcriptFile: session.transcriptFile,
                    chunkCount: session.transcriptBuffer.length
                });
                if (session.publisherId && session.streamName) {
                    Session.postMessage(Q, {
                        publisherId: session.publisherId,
                        streamName: session.streamName,
                        byUserId: userId,
                        byClientId: session.socketId,
                        type: 'Media/presentation/end',
                        instructions: JSON.stringify({
                            relSec: Session.relSec(session),
                            transcriptMessageCount: session.transcriptBuffer.length,
                        }),
                    });
                }
                Q.log && Q.log('AI session ended (grace expired)', userId, session.sessionToken);
            });
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
 *   AI/veto/show       { proposal, windowMs }                     host only
 *   AI/coaching        { text, sourceUri }                        host only
 *   AI/proposal/show   { proposalId, visualizationType, visualizationData,
 *                        streamType, citations }
 *   AI/error           { message, code }
 */

/* * * */