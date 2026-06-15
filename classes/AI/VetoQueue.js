"use strict";

/**
 * @module AI
 */

var CardCommit = require('./CardCommit');

/**
 * Veto window for AI proposals.
 *
 * The host has a few seconds to cancel a proposal before it auto-commits.
 * Higher-confidence proposals get a shorter window. In narration mode,
 * proposals auto-commit immediately (no human gate).
 *
 * @class AI.VetoQueue
 * @static
 */
function VetoQueue() {}

/**
 * Enqueue a proposal. Emits AI/veto/show and starts the auto-commit timer.
 * @method enqueue
 * @static
 */
VetoQueue.enqueue = function (session, proposal, AI, Q, Users) {
    var proposalId = proposal.proposalId || ('prop_' + Date.now());
    proposal.proposalId = proposalId;

    // Narration mode: auto-commit immediately, no veto window
    if (session.mode === 'narration') {
        session.vetoQueue.push(proposal);
        VetoQueue.commit(session, proposalId, AI, Q, Users);
        return;
    }

    var windowMs = proposal.confidence > 0.9 ? 3000 : 5000;
    session.vetoQueue.push(proposal);
    Users.Socket.emitToUser(session.userId, 'AI/veto/show', { proposal: proposal, windowMs: windowMs });

    var timer = setTimeout(function () {
        VetoQueue.commit(session, proposalId, AI, Q, Users);
    }, windowMs);
    session.vetoTimers.set(proposalId, timer);
};

/**
 * Commit a queued proposal — clears its timer, runs the show-on-canvas
 * dispatch via CardCommit, emits AI.emit('commit') and AI/veto/commit.
 * @method commit
 * @static
 */
VetoQueue.commit = function (session, proposalId, AI, Q, Users) {
    var timer = session.vetoTimers.get(proposalId);
    if (timer) { clearTimeout(timer); session.vetoTimers.delete(proposalId); }

    var proposal = session.vetoQueue.find(function (p) { return p.proposalId === proposalId; });
    if (!proposal) return;
    session.vetoQueue = session.vetoQueue.filter(function (p) { return p.proposalId !== proposalId; });

    CardCommit.show(session, proposal, AI, Q, Users);

    AI.emit('commit',
        session.userId, session.publisherId, session.streamName, proposal);
    Users.Socket.emitToUser(session.userId, 'AI/veto/commit', { proposalId: proposalId });
};

/**
 * Cancel a queued proposal — clears the timer and emits AI/veto/cancel.
 * @method cancel
 * @static
 */
VetoQueue.cancel = function (session, proposalId, Users) {
    var timer = session.vetoTimers.get(proposalId);
    if (timer) { clearTimeout(timer); session.vetoTimers.delete(proposalId); }
    session.vetoQueue = session.vetoQueue.filter(function (p) { return p.proposalId !== proposalId; });
    Users.Socket.emitToUser(session.userId, 'AI/veto/cancel', { proposalId: proposalId });
};

module.exports = VetoQueue;
