"use strict";

/**
 * @module AI
 */

var ControlClassifier = require('../../../Streams/classes/Streams/ControlClassifier');

/**
 * Per-socket AI session state and registry.
 *
 * @class AI.Session
 * @static
 */
function Session() {}

/**
 * Active sessions keyed by socket.id.
 * @property all
 * @type {Map}
 * @static
 */
Session.all = new Map();

/**
 * Create a new session for a connected socket. Closes any previous
 * session on the same socket before installing the new one.
 *
 * @method create
 * @static
 * @param {Object} client    socket.io client
 * @param {String} userId
 * @param {Object} data      payload from AI/transcription/session/start
 * @param {Object} Q
 * @return {Object} the new session object
 */
Session.create = function (client, userId, data, Q) {
    var lang        = (data && data.lang)        || 'en-US';
    var sampleRate  = (data && data.sampleRate)  || 16000;
    var publisherId = (data && data.publisherId) || null;
    var streamName  = (data && data.streamName)  || null;
    var role        = (data && data.role)        || 'participant';
    var mode        = (data && data.mode)        || 'live';
    var modes = {
        composition:   (data && data.modes && data.modes.composition  !== false),
        navigation:    (data && data.modes && data.modes.navigation   !== false),
        transcription: (data && data.modes && data.modes.transcription !== false),
    };

    var session = {
        userId:           userId,
        socketId:         client.id,
        socket:           client,
        role:             role,
        lang:             lang,
        mode:             mode,
        modes:            modes,
        sampleRate:       sampleRate,
        publisherId:      publisherId,
        streamName:       streamName,
        toolStreamName:   (data && data.toolStreamName)  || null,
        toolPublisherId:  (data && data.toolPublisherId) || userId,
        slideIndex:       0,
        revealIndex:      0,
        zoomScale:        1,
        transcription:    null,
        transcriptBuffer: [],
        transcriptFile:   null,
        _displayNames:    {},
        sessionStartMs:   Date.now(),
        isOwnLivestream:  !!(data && data.isOwnLivestream),
        classifier:       new ControlClassifier({ Q: Q }),
        pipeline:         null,
        vetoQueue:        [],
        vetoTimers:       new Map(),
    };

    // Close any previous session on this socket
    var prev = Session.all.get(client.id);
    if (prev) Session.close(prev);

    Session.all.set(client.id, session);
    session.classifier.locale = lang.split('-')[0];
    session.classifier.reload();

    return session;
};

/**
 * Look up the session for a socket.
 * @method get
 * @static
 * @param {String} socketId
 * @return {Object|null}
 */
Session.get = function (socketId) {
    return Session.all.get(socketId) || null;
};

/**
 * Remove a session from the registry without tearing down resources.
 * Use {{#crossLink "AI.Session/close:method"}}{{/crossLink}} for full teardown.
 * @method remove
 * @static
 */
Session.remove = function (socketId) {
    Session.all.delete(socketId);
};

/**
 * Close a session: stop transcription, clear veto timers, leave it
 * to the caller to remove from the registry if desired.
 * @method close
 * @static
 * @param {Object} session
 */
Session.close = function (session) {
    if (!session) return;
    if (session.transcription) {
        try { session.transcription.close(); } catch (e) {}
        session.transcription = null;
    }
    if (session.vetoTimers) {
        session.vetoTimers.forEach(function (t) { clearTimeout(t); });
        session.vetoTimers.clear();
    }
};

/**
 * Convenience: compute relSec from the session start.
 * @method relSec
 * @static
 * @param {Object} session
 * @return {String}
 */
Session.relSec = function (session) {
    return ((Date.now() - session.sessionStartMs) / 1000).toFixed(1);
};

/**
 * Post a durable message to a session's presentation stream.
 * Fire-and-forget — errors are logged.
 * @method postMessage
 * @static
 * @param {Object} Q
 * @param {Object} fields  Streams.Message.post fields
 * @param {Function} [callback]  (err, message)
 */
Session.postMessage = function (Q, fields, callback) {
    try {
        var Streams = Q.require('Streams');
        Streams.Message.post(Object.assign({
            byClientId: '',
            weight: 1
        }, fields), function (err, message) {
            if (err) Q.log && Q.log('AI: message post error', err.message || err);
            if (callback) callback(err, message);
        });
    } catch (e) {
        Q.log && Q.log('AI: postMessage exception', e.message);
        if (callback) callback(e);
    }
};

module.exports = Session;
