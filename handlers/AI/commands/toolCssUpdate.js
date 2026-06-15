"use strict";

/**
 * AI/handlers/AI/commands/toolCssUpdate.js
 *
 * Q.handler for CSS update commands on generated tools.
 * Loaded into Q.handlers.AI.commands.toolCssUpdate.
 *
 * When the host says "make it red and black" or "add shadows to the
 * pieces", the Pipeline returns action='ephemeral',
 * ephemeralType='AI/tool/cssUpdate'. This handler translates the natural
 * language into a Q/style socket event targeting the generated tool
 * element by id.
 *
 * The Q/style event updates scoped CSS custom properties (--AI-accent,
 * --AI-bg, etc.) without re-evaluating or re-rendering the tool. The
 * listenForStyle handler on the client
 * (Q/web/js/methods/Q/Socket/listenForStyle.js) injects a scoped <style>
 * tag replacing the previous one — idempotent.
 *
 * PROVIDER
 * ────────
 * Routed through AI_LLM.route(...) — provider is config-driven, default
 * route is 'fast' (this is a small, cheap translation; haiku/mini-class
 * model is plenty). Structured JSON output is enforced via
 * response_format='json_schema' with a schema that constrains the keys
 * to known CSS custom properties, so the parser can't be tricked into
 * unexpected shapes.
 *
 * @param {Object} captures  { prompt, elementId, toolName }
 * @param {Object} stream    Stream proxy
 * @param {Object} state     Presentation state
 * @param {Object} Q         Server-side Q object
 */
const AI_LLM = require('../../../classes/AI/LLM');

const SYSTEM_PROMPT = 'You translate natural language CSS requests into JSON.\n' +
    'The tool has these CSS custom properties: --AI-bg, --AI-accent, --AI-accent2,\n' +
    '--AI-text, --AI-border, --AI-sq-light, --AI-sq-dark, --AI-sq-select.\n' +
    'Return ONLY a JSON object mapping property names to colour values.\n' +
    'Example: {"--AI-accent":"#ef4444","--AI-accent2":"#1a1a1a"}\n' +
    'Use any subset of the listed properties — only include the ones the user\'s\n' +
    'request actually touches. No explanation, no markdown, just the JSON.';

const RESPONSE_SCHEMA = {
    type: 'object',
    properties: {
        '--AI-bg':        { type: 'string' },
        '--AI-accent':    { type: 'string' },
        '--AI-accent2':   { type: 'string' },
        '--AI-text':      { type: 'string' },
        '--AI-border':    { type: 'string' },
        '--AI-sq-light':  { type: 'string' },
        '--AI-sq-dark':   { type: 'string' },
        '--AI-sq-select': { type: 'string' }
    },
    additionalProperties: false
};

module.exports = async function toolCssUpdate(captures, stream, state, Q) {
    const prompt    = captures && captures.prompt;
    const elementId = captures && captures.elementId;
    if (!prompt || !elementId) return;

    const routeName = Q.Config.get(['AI', 'commands', 'tool/cssUpdate', 'route'], 'fast');

    const adapter = AI_LLM.route(routeName, {
        response_format: 'json_schema',
        json_schema:     RESPONSE_SCHEMA,
        max_tokens:      200,
        temperature:     0
    });
    if (!adapter) {
        Q.log && Q.log('AI/toolCssUpdate: no LLM adapter for route "' + routeName + '"');
        return;
    }

    let raw;
    try {
        raw = await adapter.executeModel(
            SYSTEM_PROMPT,
            { text: prompt },
            {
                response_format: 'json_schema',
                json_schema:     RESPONSE_SCHEMA,
                max_tokens:      200,
                temperature:     0
            }
        );
    } catch (e) {
        Q.log && Q.log('AI/toolCssUpdate: LLM error', e.message);
        return;
    }

    const text = (typeof raw === 'string') ? raw : (raw && raw.text) || '';
    if (!text) return;

    let vars;
    try {
        vars = JSON.parse(_stripMarkdownFences(text));
    } catch (e) {
        Q.log && Q.log('AI/toolCssUpdate: parse error', e.message, 'text:', text.slice(0, 120));
        return;
    }
    if (!vars || typeof vars !== 'object' || !Object.keys(vars).length) return;

    // Emit Q/style as a stream EPHEMERAL — not a socket event.
    // Socket events only reach the user's own clients; the presentation
    // stream ephemeral reaches all screens (shared ?f=1, audience phones,
    // host pane). Each screen calls Q.handle(Q.Socket.onEvent('Q/style'), ...)
    // which re-uses the listenForStyle injection logic uniformly.
    stream.ephemeral('Q/style', {
        elementId: elementId,
        selector:  '*',
        vars:      vars
    });

    Q.log && Q.log('AI/toolCssUpdate: patched',
        Object.keys(vars).length, 'vars on', elementId);
};

function _stripMarkdownFences(text) {
    if (!text) return '';
    return text
        .replace(/^\s*```(?:javascript|js|json)?\s*\n?/i, '')
        .replace(/\n?```\s*$/i, '')
        .trim();
}
