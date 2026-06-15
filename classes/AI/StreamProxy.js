"use strict";

/**
 * @module AI
 */

var Session = require('./Session');
var transcriptEmitter = require('../../../Streams/classes/Streams/TranscriptEmitter').transcriptEmitter;

/**
 * Adapter that lets Media's `ControlClassifier` (which expects a `stream`
 * object with `.ephemeral(type, payload)`) be driven from the server side
 * during transcript classification, without requiring a hydrated
 * Streams_Stream instance.
 *
 * Two things changed vs the older shape of this file:
 *
 * 1. The legacy `Streams/slide` and `Streams/reveal` ephemerals are no
 *    longer emitted. The Media plugin's `messages.json` flags them as
 *    legacy, and the canonical event for those is now a durable
 *    `Media/presentation/{slide,reveal}` message. This proxy now posts
 *    that message and writes the matching VTT cue, so the recording and
 *    chapter markers stay correct regardless of who classified the intent
 *    (client classifier, server classifier, or LLM pipeline).
 *
 * 2. Other ephemerals — `Streams/zoom`, `Streams/play`, `Streams/pause`,
 *    `Streams/seek`, `Streams/highlight`, `Q/scroll`, `Q/fullscreen`,
 *    gallery/* — remain ephemeral. They are explicitly live in
 *    messages.json (no legacy flag) and don't need a durable record.
 *
 * Long-term home: the slide/reveal posting belongs in the Media plugin
 * (the durable message types are Media/*). The adapter shape stays here
 * because it's bound to an AI Session. When Media exposes a
 * `Media.Session.postPresentationEvent(...)` helper, this file can call
 * into it and drop the direct Session.postMessage usage.
 *
 * @class AI.StreamProxy
 * @static
 */
function StreamProxy() {}

/**
 * Build an adapter bound to a session. Classifier calls
 *   proxy.ephemeral(type, payload)
 * and the adapter either fans out the live event (ephemerals that stayed
 * ephemeral) or posts a durable message (slide, reveal) + tracks state.
 *
 * @method make
 * @static
 * @param {Object} session  AI session
 * @param {Object} Q
 * @param {Object} Users
 * @return {{ephemeral: Function}}
 */
StreamProxy.make = function (session, Q, Users) {
    return {
        ephemeral: function (type, payload) {
            if (!session.publisherId) return;
            payload = payload || {};

            // ── Slide and reveal are now durable messages, not ephemerals.
            //    The legacy ephemeral names get translated to the canonical
            //    Media/presentation/* durable forms. Clients listening on
            //    onMessage('Media/presentation/slide') etc. catch these.
            if (type === 'Streams/slide' && payload.slideIndex != null) {
                session.slideIndex = payload.slideIndex;
                StreamProxy._postPresentationRecord(
                    session, 'Media/presentation/slide',
                    { index: payload.slideIndex }, Q
                );
                return;
            }
            if (type === 'Streams/reveal' && payload.revealIndex != null) {
                session.revealIndex = payload.revealIndex;
                StreamProxy._postPresentationRecord(
                    session, 'Media/presentation/reveal',
                    { index: payload.revealIndex }, Q
                );
                return;
            }

            // ── Zoom stays ephemeral (no legacy flag in messages.json),
            //    but we still cache the scale for downstream pipeline gating.
            if (type === 'Streams/zoom' && payload.scale != null) {
                session.zoomScale = payload.scale;
            }

            // ── Everything else (zoom, play/pause/seek, scroll, gallery/*,
            //    highlight, fullscreen) is a live-only ephemeral. Fan out
            //    to all of the user's /Q clients.
            Users.Socket.emitToUser(session.userId, 'AI/ephemeral', {
                publisherId: session.publisherId,
                streamName:  session.streamName,
                type:        type,
                payload:     payload
            });
        }
    };
};

/**
 * Post a durable Media/presentation/{slide,reveal,...} message and write
 * the matching VTT NOTE so chapter markers in the recording stay aligned
 * with what actually happened on screen.
 *
 * @method _postPresentationRecord
 * @private
 * @static
 * @param {Object} session
 * @param {String} type             e.g. 'Media/presentation/slide'
 * @param {Object} extraInstructions Extra fields to merge into instructions
 *                                  (index/value/etc — relSec is added here)
 * @param {Object} Q
 */
StreamProxy._postPresentationRecord = function (session, type, extraInstructions, Q) {
    var relSec = Session.relSec(session);
    var instr  = JSON.stringify(Object.assign(
        { relSec: relSec },
        extraInstructions || {}
    ));
    Session.postMessage(Q, {
        publisherId:  session.publisherId,
        streamName:   session.streamName,
        byUserId:     session.userId,
        type:         type,
        instructions: instr,
    }, function (err, message) {
        if (!err && message) {
            transcriptEmitter._appendVttEventNote(
                session,
                type,
                message.fields.ordinal,
                instr,
                Q,
                message.fields.sentTime
            );
        }
    });
};

module.exports = StreamProxy;
