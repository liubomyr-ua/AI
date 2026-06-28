"use strict";

/**
 * AI/handlers/AI/commands/imageGenerate.js
 *
 * Q.handler for the 'image/generate' voice command intent. Loads
 * automatically into Q.handlers.AI.commands.imageGenerate.
 *
 * Called by CommandsClassifier when it matches an image/generate intent.
 * Generates an image via the configured AI_Image adapter (Google/Vertex,
 * OpenAI, AWS, etc.) and adds it to the presentation's background gallery.
 * Falls back to a Pexels gallery query when no adapter is configured or the
 * call fails.
 *
 * CONFIG
 * ──────
 *   AI/image/default          Default provider name if options don't specify.
 *                              Defaults to 'openai' if not set.
 *                              Examples: 'google'|'openai'|'aws'
 *
 *   AI/image/providers        Provider-specific config:
 *                              {
 *                                "openai": {"model": "dall-e-3"},
 *                                "aws": {"model": "stability.stable-diffusion-xl-v0"},
 *                                "google": {"background": "transparent"}
 *                              }
 *
 *   AI/google/url             For Google adapter: signed-proxy URL
 *   AI/google/clientId        For Google adapter: client ID for HMAC signing
 *   AI/google/secret          For Google adapter: secret for HMAC signing
 *
 * @param {Object} captures   { prompt: String, provider?: String }
 * @param {Object} stream     Stream proxy with .ephemeral(type, payload)
 * @param {Object} state      Presentation state
 * @param {Object} Q          Server-side Q object
 */
const AI_Image = require('../../../classes/AI/Image');

module.exports = async function imageGenerate(captures, stream, state, Q) {
    const prompt = captures && captures.prompt;
    if (!prompt || !prompt.trim()) return;

    // Resolve provider: caller's captures.provider → config default → hardcoded default
    let providerName = captures && captures.provider;
    if (!providerName) {
        providerName = Q.Config && Q.Config.get(['AI', 'image', 'default'], 'openai');
    }
    providerName = _resolveAdapterName(providerName);

    Q.log && Q.log('AI/imageGenerate: generating "' + prompt + '"' +
        (providerName ? ' via ' + providerName : ' (no provider configured)'));

    // Load provider config
    const providerConfig = (Q.Config && Q.Config.get(['AI', 'image', 'providers', providerName], {})) || {};
    const adapter = providerName ? AI_Image.create(providerName, providerConfig) : null;

    if (!adapter) {
        // No adapter — fall back to Pexels stock photo gallery query.
        // Fast, free, no rate limit risk. Good demo behaviour.
        Q.log && Q.log('AI/imageGenerate: no adapter, falling back to Pexels');
        stream.ephemeral('Streams/gallery/query', { query: prompt });
        return;
    }

    // Merge default options with caller-supplied options
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
            Q.log && Q.log('AI/imageGenerate: adapter returned no image, falling back to Pexels');
            stream.ephemeral('Streams/gallery/query', { query: prompt });
            return;
        }

        // Add generated image to gallery with Ken Burns effect
        stream.ephemeral('Streams/gallery/add', {
            src:                imageUrl,
            caption:            prompt,
            insertAfterCurrent: true,
            interval:           { type: 'kenburns', duration: 8000 }
        });
    } catch (e) {
        Q.log && Q.log('AI/imageGenerate: adapter error: ' + (e && e.message ? e.message : String(e)));
        stream.ephemeral('Streams/gallery/query', { query: prompt });
    }
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Map the provider name to the AI_Image factory's expected adapter name.
 * Handles legacy aliases and normalization.
 * 
 * @param {string} provider Provider name from config or captures
 * @returns {string} Normalized adapter name
 */
function _resolveAdapterName(provider) {
    if (!provider) return 'openai';  // Default fallback
    
    const normalized = provider.toLowerCase().trim();
    
    // Legacy alias: 'vertex' → 'google' (Google Cloud Vertex AI)
    if (normalized === 'vertex') {
        return 'google';
    }
    
    // Accept: 'google', 'openai', 'aws', 'ideogram', 'hotpotai', etc.
    return normalized;
}

/**
 * Normalise an adapter's generate() return value into a URL the gallery
 * can render. Adapters return one of several shapes:
 * 
 *   { data: Buffer, format: 'png'|'jpg' }   ← Google, AWS
 *   { b64_json: String }                     ← AWS (base64-encoded)
 *   { url: String }                          ← OpenAI (direct URL)
 *   { error: ... }                           ← any adapter on failure
 *
 * For raw bytes we emit a data: URL. Small images render inline; for
 * larger production pipelines, swap this for a save-to-uploads/Streams/AI/
 * flow that returns a CDN-friendly URL.
 * 
 * @param {object} result Result from adapter.generate()
 * @param {string} prompt Original prompt (for logging)
 * @param {object} Q Server Q object (for logging)
 * @returns {string|null} Data URL or HTTP URL, or null on error
 */
function _resultToUrl(result, prompt, Q) {
    if (!result) {
        Q.log && Q.log('AI/imageGenerate: adapter returned null result');
        return null;
    }

    if (result.error) {
        const errMsg = typeof result.error === 'string' 
            ? result.error 
            : (result.error && result.error.message ? result.error.message : JSON.stringify(result.error).slice(0, 200));
        Q.log && Q.log('AI/imageGenerate: adapter error: ' + errMsg);
        return null;
    }

    // Direct URL (OpenAI style)
    if (result.url) {
        return result.url;
    }

    // Base64-encoded JSON (AWS style: b64_json field)
    if (result.b64_json) {
        const buf = Buffer.from(result.b64_json, 'base64');
        const fmt = result.format || 'png';
        const mime = fmt === 'jpg' || fmt === 'jpeg' ? 'image/jpeg' : 'image/' + fmt;
        return 'data:' + mime + ';base64,' + buf.toString('base64');
    }

    // Raw binary data (Google, AWS style: data + format fields)
    if (result.data) {
        const buf = Buffer.isBuffer(result.data)
            ? result.data
            : (typeof result.data === 'string'
                ? Buffer.from(result.data, 'base64')
                : Buffer.from(result.data));

        const fmt  = (result.format || 'png').toLowerCase();
        const mime = fmt === 'jpg' || fmt === 'jpeg' ? 'image/jpeg' : 'image/' + fmt;
        return 'data:' + mime + ';base64,' + buf.toString('base64');
    }

    Q.log && Q.log('AI/imageGenerate: adapter returned no image data (no url, data, or b64_json)');
    return null;
}