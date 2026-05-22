"use strict";
/*jshint node:true */
/**
 * AI plugin
 * @module AI
 * @main AI
 */
var Q = require('Q');
var Users = Q.require('Users');
var Streams = require('Streams');
var Db = Q.require('Db');

/**
 * AI methods for the AI model
 * @class AI
 * @static
 */
function AI() { }
module.exports = AI;

var socket = null;

AI.Image        = Q.require('AI/Image');         // TensorFlow face detection (original)
AI.LLM          = Q.require('AI/LLM');           // LLM adapters (OpenAI, Google, AWS)
AI.Transcription = Q.require('AI/Transcription'); // Transcription adapters

Q.makeEventEmitter(AI);

/**
 * Start internal listener for AI plugin.
 *
 * Registers Q/method handlers via the framework's server.addMethod() API
 * (introduced alongside the IPC dispatcher in Q.listen). The legacy
 * /Q/node express mount point is no longer used directly — the framework
 * routes incoming internal POSTs by Q/method to the right handler.
 *
 * Methods registered:
 *   AI/Image/estimateFaces              — TensorFlow face detection callback
 *   AI/Transcription/Xai/transcribe     — xAI Speech-to-Text async job
 *
 * @method listen
 * @static
 */
AI.listen = function (options) {
    if (AI.listen.result) {
        return AI.listen.result;
    }

    // Start internal server
    var server = Q.listen();

    // AI/Image/estimateFaces — run TensorFlow face detection, store predictions
    // on the target stream when finished.
    server.addMethod('AI/Image/estimateFaces', function (parsed) {
        var imagePath = Q.getObject("imagePath", parsed);
        AI.Image.estimateFaces(imagePath, function (predictions) {
            var publisherId = Q.getObject("publisherId", parsed);
            var streamName = Q.getObject("streamName", parsed);
            if (!publisherId || !streamName) {
                return console.warn("AI/Image/estimateFaces: missing publisherId or streamName in request");
            }
            Streams.fetchOne(publisherId, publisherId, streamName, function (err, stream) {
                // Don't silently swallow failures — log them so operators can
                // see why predictions never landed on the stream.
                if (err) {
                    return console.error("AI/Image/estimateFaces: Streams.fetchOne failed for "
                        + publisherId + "/" + streamName + ":", err);
                }
                if (!stream) {
                    return console.error("AI/Image/estimateFaces: stream not found: "
                        + publisherId + "/" + streamName);
                }
                stream.setAttribute("predictions", predictions);
                stream.save();
            });
        });
    });

    // AI/Transcription/Xai/transcribe — run xAI Speech-to-Text.
    // PHP delegates here via Q_Utils::sendToNode with 'job: true' so it can
    // return immediately without blocking a PHP-FPM worker on the multi-second
    // multipart upload to api.x.ai. When the transcription completes,
    // ctx.done() fires the PHP webhook with the result plus the echo context
    // passed through untouched.
    server.addMethod('AI/Transcription/Xai/transcribe', function (parsed, req, res, ctx) {
        var source = Q.getObject("source", parsed);
        var options = Q.getObject("options", parsed) || {};
        // Defensive: if the framework dispatcher didn't supply ctx,
        // fall back to a no-op done so the adapter still runs.
        var done = (ctx && typeof ctx.done === 'function')
            ? ctx.done
            : function () {};
        if (!source) {
            console.warn("AI/Transcription/Xai/transcribe: missing source URL");
            done({ status: 'FAILED', error: 'missing source URL' });
            return;
        }

        var adapter = new AI.Transcription.Xai();
        adapter.transcribe(source, options)
        .then(function (result) {
            done(result);
        })
        .catch(function (err) {
            console.error("AI/Transcription/Xai/transcribe: adapter failed for source "
                + source + ":", err);
            done({ status: 'FAILED', error: (err && err.message) || String(err) });
        });
    });

    // Start external socket server
    var node = Q.Config.get(['Q', 'node']);
    if (!node) return false;

    var pubHost = Q.Config.get(['AI', 'node', 'host'], Q.Config.get(['Q', 'node', 'host'], null));
    var pubPort = Q.Config.get(['AI', 'node', 'port'], Q.Config.get(['Q', 'node', 'port'], null));

    if (pubHost === null) throw new Q.Exception("AI: Missing config field: AI/node/host");
    if (pubPort === null) throw new Q.Exception("AI: Missing config field: AI/node/port");

    socket = Users.Socket.listen({
        host: pubHost,
        port: pubPort,
        https: Q.Config.get(['Q', 'node', 'https'], false) || {},
    });

    socket.io.of('/Q').on('connection', function(client) {
        if (client.alreadyListeningAI) return;
        client.alreadyListeningAI = true;
        client.on('disconnect', function() {});
    });

    return AI.listen.result = {
        internal: server,
        socket: socket
    };
};
