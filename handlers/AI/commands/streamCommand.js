"use strict";

/**
 * AI/handlers/AI/commands/streamCommand.js
 *
 * Handles voice/text commands that create streams or modify access control.
 *
 * FLOW
 * ────
 *  1. ControlClassifier captures intent + display name ("Robert")
 *  2. Node resolves display name → userId via Streams.Avatar.fetchByPrefix
 *     (native static method, direct DB query — no PHP roundtrip)
 *  3. Node posts an immediate ack message to the chat via Streams.Message.post()
 *  4. Node calls sendToPHP('AI/stream/command') — PHP action executes the
 *     privileged op (Streams::create, Streams_Access::save, etc.) as asUserId
 *  5. PHP action posts the result message to chat (success string or exception text)
 *     and returns the result in slots for Node to use if needed
 *
 * Node→PHP calls use Q.Utils.sendToPHP() which signs the payload with the
 * internal secret and POSTs to action.php/{path}. PHP verifies the signature
 * via Q_Utils::verify() in the action handler.
 *
 * @param {Object} params
 *   @param {String} params.command     'create' | 'grantAccess' | 'revokeAccess'
 *   @param {String} params.userId      asUserId performing the action
 *   @param {String} params.publisherId presentation stream publisherId
 *   @param {String} params.streamName  presentation stream streamName
 *   @param {String} params.chatStreamName  Streams/chat backing stream
 *   @param {String} [params.targetName]    raw display name from NER ("Robert")
 *   @param {String} [params.writeLevel]    'post' | 'ephemeral' | 'contribute'
 *   @param {String} [params.toolTitle]     for create command
 * @param {Object} Q      Server-side Q object (has Q.Utils.sendToPHP)
 * @param {Object} Users  Users module
 */

module.exports = async function streamCommand(params, Q, Users) {
    const {
        command, userId, publisherId, streamName, chatStreamName,
        targetName, writeLevel, toolTitle
    } = params;

    if (!userId || !chatStreamName) return;

    const Streams = Q.require('Streams');

    // ── Step 1: Resolve display name → userId via Streams.Avatar.fetchByPrefix ──
    let targetUserId  = params.targetUserId || '';
    let targetDisplay = targetName || targetUserId;

    if (targetName && !targetUserId) {
        try {
            const avatars = await new Promise(function (resolve, reject) {
                Streams.Avatar.fetchByPrefix(
                    userId, targetName, { limit: 1 },
                    function (err, rows) { err ? reject(err) : resolve(rows); }
                );
            });
            const firstId = Object.keys(avatars)[0];
            if (firstId) {
                targetUserId  = firstId;
                const row     = avatars[firstId].fields;
                targetDisplay = [row.firstName, row.lastName].filter(Boolean).join(' ').trim()
                             || row.username || targetName;
            }
        } catch (e) {
            Q.log && Q.log('AI/streamCommand: avatar lookup failed', e.message);
        }
    }

    // ── Step 2: Post immediate acknowledgment to chat ─────────────────────
    const ackText = {
        'create':       `Creating "${toolTitle || 'tool'}" stream…`,
        'grantAccess':  `Granting ${targetDisplay} access to post…`,
        'revokeAccess': `Removing access for ${targetDisplay}…`,
    }[command] || 'Processing…';

    await _postMessage(Streams, {
        publisherId: userId,
        streamName:  chatStreamName,
        byUserId:    userId,
        type:        'AI/command/ack',
        content:     ackText,
    });

    // ── Step 3: Execute PHP action via sendToPHP ──────────────────────────
    try {
        await Q.Utils.sendToPHP('AI/stream/command', {
            command,
            asUserId:         userId,
            publisherId,
            streamName,
            chatPublisherId:  userId,
            chatStreamName,
            targetUserId,
            targetDisplay,
            writeLevel:       writeLevel || 'post',
            toolTitle:        toolTitle  || 'Tool',
        });
    } catch (e) {
        Q.log && Q.log('AI/streamCommand: PHP error', e.message);
        await _postMessage(Streams, {
            publisherId: userId,
            streamName:  chatStreamName,
            byUserId:    userId,
            type:        'AI/command/error',
            content:     e.message || 'Command failed',
        });
    }
};

function _postMessage(Streams, fields) {
    return new Promise(function (resolve) {
        try {
            Streams.Message.post(fields, function () { resolve(); });
        } catch (e) { resolve(); }
    });
}