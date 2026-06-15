'use strict';
/**
 * AI/handlers/AI/commands/slideGenerate.js
 *
 * Handles slide proposals from the LLM pipeline.
 * Called from _createAndShowSlide() in socket.js when
 * visualizationType === 'slide'.
 *
 * Flow:
 *   1. Emit AI/proposal/show immediately — control.js relays to presentation
 *      stream, shared screen activates Media/presentation/card/slide inline
 *      (no stream fetch needed, HTML passed directly as visualizationData).
 *   2. Build-in animations handled client-side by Media/presentation/card/slide.
 *   3. Post durable Media/presentation/card/show message for VTT / replay.
 *
 * The slide tool (Media/presentation/card/slide) renders the HTML directly
 * from visualizationData — no Streams stream is created server-side.
 * This keeps the slide path fast and avoids a PHP roundtrip.
 *
 * @param {Object} session
 * @param {Object} proposal   { visualizationData: { html, buildAuto, buildStagger, credit }, proposalId }
 * @param {Object} AI
 * @param {Object} Q
 * @param {Object} Users
 */
module.exports = async function slideGenerate(session, proposal, AI, Q, Users) {
    var data      = proposal.visualizationData || {};
    var streamType = 'Media/card/slide';

    var relSec = ((Date.now() - session.sessionStartMs) / 1000).toFixed(1);

    // ── 1. Fan out to shared screen immediately ───────────────────────────────
    Users.Socket.emitToUser(session.userId, 'AI/proposal/show', {
        proposalId:        proposal.proposalId,
        visualizationType: 'slide',
        visualizationData: data,
        streamType:        streamType
    });

    // Build-in animations are handled client-side by Media/presentation/card/slide.
    // When state.buildAuto is true, the tool calls buildAll() after activation.
    // No server-side ephemeral sequence needed for inline cards.

    // ── 3. Durable record ─────────────────────────────────────────────────────
    if (session.publisherId && session.streamName) {
        var instructions = JSON.stringify({
            visualizationType: 'slide',
            visualizationData: data,
            streamType:        streamType,
            proposalId:        proposal.proposalId,
            relSec:            relSec
        });
        var Str = Q.require('Streams');
        Str.Message.post({
            publisherId:  session.publisherId,
            streamName:   session.streamName,
            byUserId:     session.userId,
            byClientId:   '',
            weight:       1,
            type:         'Media/presentation/card/show',
            instructions: instructions
        }, function (err) {
            if (err) Q.log && Q.log('slideGenerate: message post error', err);
        });
    }
};
