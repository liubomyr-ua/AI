"use strict";

/**
 * AI/handlers/AI/commands/imageGenerate.js
 *
 * Q.handler for the 'image/generate' voice command intent. Loaded
 * automatically into Q.handlers.AI.commands.imageGenerate.
 *
 * Called by ControlClassifier when it matches an image/generate intent.
 * Generates an image via the configured AI_Image adapter (Google/Vertex,
 * OpenAI, Ideogram, Hotpotai, AWS, etc.) and adds it to the
 * presentation's background gallery. Falls back to a Pexels gallery
 * query when no adapter is configured or the call fails.
 *
 * CONFIG
 * ──────
 *   AI/image/provider          Adapter name, e.g. 'google'|'openai'|
 *                              'ideogram'|'hotpotai'|'aws'. The legacy
 *                              label 'vertex' is accepted as an alias
 *                              for 'google' (Google Cloud's Vertex AI is
 *                              what AI_Image.Google wraps). null disables
 *                              generation and the Pexels fallback fires.
 *
 *   AI/google/url              Signed-proxy URL the Google adapter calls
 *   AI/google/clientId         (the adapter does HMAC signing; it does
 *   AI/google/secret           not call Vertex's REST API directly).
 *
 *   AI/image/options           Default options passed to adapter.generate
 *                              (aspectRatio, size, etc.). Caller-supplied
 *                              options take precedence.
 *
 * @param {Object} captures   { prompt: String, options?: Object }
 * @param {Object} stream     Stream proxy with .ephemeral(type, payload)
 * @param {Object} state      Presentation state
 * @param {Object} Q          Server-side Q object
 */
const AI_Image = require('../../../classes/AI/Image');

module.exports = async function imageGenerate(captures, stream, state, Q) {
    const prompt = captures && captures.prompt;
    if (!prompt || !prompt.trim()) return;

    const configured = Q.Config && Q.Config.get(['AI', 'image', 'provider'], null);
    const adapterName = _resolveAdapterName(configured);

    Q.log && Q.log('AI/imageGenerate: generating "' + prompt + '"' +
        (adapterName ? ' via ' + adapterName : ' (no provider configured)'));

    const adapter = adapterName ? AI_Image.create(adapterName) : null;
    if (!adapter) {
        // No adapter — fall back to Pexels stock photo gallery query.
        // Fast, free, no 429 risk. Good demo behaviour.
        stream.ephemeral('Streams/gallery/query', { query: prompt });
        return;
    }

    const defaultOptions = (Q.Config && Q.Config.get(['AI', 'image', 'options'], {})) || {};
    const callerOptions  = (captures && captures.options) || {};
    const options = Object.assign(
        { aspectRatio: '16:9', format: 'png' },
        defaultOptions,
        callerOptions
    );

    try {
        const result = await adapter.generate(prompt, options);
        const imageUrl = _resultToUrl(result, prompt, Q);
        if (!imageUrl) {
            stream.ephemeral('Streams/gallery/query', { query: prompt });
            return;
        }

        stream.ephemeral('Streams/gallery/add', {
            src:                imageUrl,
            caption:            prompt,
            insertAfterCurrent: true,
            interval:           { type: 'kenburns', duration: 8000 }
        });
    } catch (e) {
        Q.log && Q.log('AI/imageGenerate: adapter error', e.message);
        stream.ephemeral('Streams/gallery/query', { query: prompt });
    }
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Map the configured provider name to the AI_Image factory's expected
 * adapter name. 'vertex' is the legacy label for Google Cloud's Vertex
 * AI image generation, which AI_Image.Google wraps.
 */
function _resolveAdapterName(provider) {
    if (!provider) return null;
    if (provider === 'vertex') return 'google';
    return provider;
}

/**
 * Normalise an adapter's generate() return value into a URL the gallery
 * can render. Adapters return one of several shapes:
 *   { data: Buffer, format: 'png'|'jpg' }   ← Google, AWS, Ideogram
 *   { url:  String }                         ← OpenAI (sometimes)
 *   { error: ... }                            ← any adapter on failure
 *
 * For raw bytes we emit a data: URL. Small images render inline; for
 * larger pipelines, swap this for a save-to-uploads/Streams/AI/ flow
 * that returns a CDN-friendly URL.
 */
function _resultToUrl(result, prompt, Q) {
    if (!result || result.error) {
        if (result && result.error) {
            Q.log && Q.log('AI/imageGenerate: adapter returned error',
                typeof result.error === 'string' ? result.error : JSON.stringify(result.error).slice(0, 200));
        }
        return null;
    }
    if (result.url) return result.url;
    if (!result.data) return null;

    const buf = Buffer.isBuffer(result.data)
        ? result.data
        : (typeof result.data === 'string'
            ? Buffer.from(result.data, 'base64')
            : Buffer.from(result.data));

    const fmt  = (result.format || 'png').toLowerCase();
    const mime = fmt === 'jpg' || fmt === 'jpeg' ? 'image/jpeg' : 'image/' + fmt;
    return 'data:' + mime + ';base64,' + buf.toString('base64');
}
