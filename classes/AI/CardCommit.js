"use strict";

/**
 * @module AI
 */

var Session = require('./Session');
var slideGenerate = require('../../handlers/AI/commands/slideGenerate');
var transcriptEmitter = require('../../../Streams/classes/Streams/TranscriptEmitter').transcriptEmitter;

/**
 * Visualization-type → card-tool-name map.
 * @property TYPE_MAP
 * @static
 */
var TYPE_MAP = {
    stat:       'Media/card/stat',
    glossary:   'Media/card/glossary',
    profile:    'Media/card/profile',
    quote:      'Media/card/quote',
    article:    'Media/card/article',
    comparison: 'Media/card/comparison',
    barChart:   'Media/chart/bar',
    lineChart:  'Media/chart/line',
    map:        'Media/card/map',
    slide:      'Media/card/slide',
};

/**
 * Dispatch a committed proposal to the right rendering path:
 *   - graph / table → ephemeral update event
 *   - slide         → slideGenerate command handler
 *   - everything else → AI/proposal/show emit + durable card message
 *
 * @class AI.CardCommit
 * @static
 */
function CardCommit() {}

/**
 * Show a committed proposal — the entry point called by VetoQueue.commit.
 * @method show
 * @static
 */
CardCommit.show = function (session, proposal, AI, Q, Users) {
    var vizType = proposal.visualizationType;

    // graph / table go through the ephemeral update path (fanned to Q/visualization/* tools)
    if (vizType === 'graph' || vizType === 'table') {
        CardCommit._ephemeralUpdate(session, proposal, Users);
        return;
    }

    // Slide proposals run through the AI-composed-HTML pipeline
    if (vizType === 'slide') {
        slideGenerate(session, proposal, AI, Q, Users).catch(function (e) {
            Q.log && Q.log('slideGenerate error:', e.message);
        });
        return;
    }

    var streamType = TYPE_MAP[vizType] || 'Media/card/glossary';
    Q.log && Q.log('AI: committing proposal', streamType, proposal.proposalId);

    var cardRelSec = Session.relSec(session);

    // Fan out AI/proposal/show — control.js relays to the presentation stream,
    // ?f=1 canvas renders it.
    Users.Socket.emitToUser(session.userId, 'AI/proposal/show', {
        proposalId:        proposal.proposalId,
        visualizationType: proposal.visualizationType,
        visualizationData: proposal.visualizationData,
        streamType:        streamType,
        citations:         proposal.citations || [],
    });

    // Durable card record — part of the presentation recording
    if (session.publisherId && session.streamName) {
        var cardInstructions = JSON.stringify({
            visualizationType: proposal.visualizationType,
            visualizationData: proposal.visualizationData,
            streamType:        streamType,
            proposalId:        proposal.proposalId,
            relSec:            cardRelSec,
            citations:         proposal.citations || [],
        });
        Session.postMessage(Q, {
            publisherId:  session.publisherId,
            streamName:   session.streamName,
            byUserId:     session.userId,
            type:         'Media/presentation/card/show',
            instructions: cardInstructions,
        }, function (err, message) {
            if (!err && message) {
                transcriptEmitter._appendVttEventNote(
                    session,
                    'Media/presentation/card/show',
                    message.fields.ordinal,
                    cardInstructions,
                    Q,
                    message.fields.sentTime
                );
            }
        });
    }
};

/**
 * Graph / table proposals fan out as ephemeral update events.
 * @method _ephemeralUpdate
 * @private
 * @static
 */
CardCommit._ephemeralUpdate = function (session, proposal, Users) {
    var ephType = proposal.visualizationType === 'graph'
        ? 'Media/presentation/graph/update'
        : 'Media/presentation/table/update';
    Users.Socket.emitToUser(session.userId, 'AI/ephemeral', {
        publisherId: session.publisherId,
        streamName:  session.streamName,
        type:        ephType,
        payload:     proposal.visualizationData || {},
    });
};

/**
 * Card replay path — fanned out from socket.on('AI/card/replay') without
 * going through the veto queue, since the proposal was already committed
 * once before. Includes citations from the historical message.
 * @method replay
 * @static
 */
CardCommit.replay = function (session, data, Users) {
    if (!data || !data.visualizationData) return;
    Users.Socket.emitToUser(session.userId, 'AI/proposal/show', {
        proposalId:        'replay_' + Date.now(),
        visualizationType: data.visualizationType,
        visualizationData: data.visualizationData,
        streamType:        data.streamType,
        citations:         data.citations || []
    });
};

module.exports = CardCommit;
