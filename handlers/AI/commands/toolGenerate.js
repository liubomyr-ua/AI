"use strict";

/**
 * AI/handlers/AI/commands/toolGenerate.js
 *
 * Q.handler for the 'tool/generate' voice command intent.
 * Loaded automatically into Q.handlers.AI.commands.toolGenerate.
 *
 * Host says "build a chess board" or "create a countdown timer". The LLM
 * generates a complete Q.Tool.define() implementation. The control page
 * evaluates it, activates it in host mode. The shared screen activates
 * the same tool in broadcast mode.
 *
 * MODES (same Q.Tool.define, different options):
 *   mode: 'host'      — interactive, in the host's control pane
 *   mode: 'broadcast' — view-only or limited, on the shared ?f=1 screen
 *
 * Works pre-Safebots because generated code runs in the browser, not on
 * the server. No external API access from the tool itself; host's own
 * session, host's own browser. v2.1 with Safebots: generated tools that
 * call external APIs, persist state, or run server-side logic go through
 * the capability manifest and governed execution environment.
 *
 * SYSTEM PROMPT
 * ─────────────
 * Loaded from AI/data/toolGenerate.prompts.json, which holds both the
 * generation prompt (`codeGen`) and an optional verification prompt
 * (`verify`) that runs against the produced code. The older single-file
 * `toolGenerate.prompt.txt` is superseded by the JSON.
 *
 * PROVIDER
 * ────────
 * Routed via AI_LLM.route(...) — provider is config-driven. The route
 * name is read from AI/commands/tool/generate/route (default 'smart').
 * Swap Anthropic ↔ OpenAI ↔ etc. without touching this file. Web search
 * is off by default for codegen (use options.webSearch=true to enable
 * if you want it for documentation lookups).
 *
 * VERIFY PASS
 * ───────────
 * If `verify` is present in the prompts JSON and AI/commands/tool/generate/verify
 * is true (default true), a second LLM call asks for { ok, reason } JSON.
 * On `ok: false`, the code is rejected with the reason logged. Cheap
 * safety net for "no fetch(), no eval, both modes handled" etc.
 *
 * @param {Object} captures  { prompt: String }
 * @param {Object} stream    Stream proxy
 * @param {Object} state     Presentation state
 * @param {Object} Q         Server-side Q object
 */
const path   = require('path');
const fs     = require('fs');
const AI_LLM = require('../../../classes/AI/LLM');

let _promptsCache = null;
function _loadPrompts(Q) {
    if (_promptsCache) return _promptsCache;
    const jsonPath = path.join(__dirname, '../../../data/toolGenerate.prompts.json');
    try {
        const raw = fs.readFileSync(jsonPath, 'utf8');
        _promptsCache = JSON.parse(raw);
    } catch (e) {
        Q.log && Q.log('AI/toolGenerate: could not load prompts JSON', e.message);
        _promptsCache = null;
    }
    return _promptsCache;
}

module.exports = async function toolGenerate(captures, stream, state, Q) {
    const prompt = captures && captures.prompt;
    if (!prompt || !prompt.trim()) return;

    Q.log && Q.log('AI/toolGenerate: generating tool for "' + prompt + '"');

    const prompts = _loadPrompts(Q);
    if (!prompts || !prompts.codeGen) {
        Q.log && Q.log('AI/toolGenerate: prompts JSON missing or has no codeGen key');
        return;
    }

    // Route name is configurable per command. Default 'smart'.
    const routeName = Q.Config.get(['AI', 'commands', 'tool/generate', 'route'], 'smart');
    const modelOverride = prompts.model || null;

    const baseOptions = {
        max_tokens:  Q.Config.get(['AI', 'commands', 'tool/generate', 'maxTokens'], 4000),
        temperature: Q.Config.get(['AI', 'commands', 'tool/generate', 'temperature'], 0.5),
        webSearch:   Q.Config.get(['AI', 'commands', 'tool/generate', 'webSearch'], false)
    };
    if (modelOverride) baseOptions.model = modelOverride;

    const adapter = AI_LLM.route(routeName, baseOptions);
    if (!adapter) {
        Q.log && Q.log('AI/toolGenerate: no LLM adapter for route "' + routeName + '"');
        return;
    }

    // ── 1. Generation pass ────────────────────────────────────────────────────
    const userPrompt = 'Build a Qbix tool for: ' + prompt.trim()
        + '\n\nReturn ONLY the Q.Tool.define() call as a self-contained '
        + 'JavaScript string. No explanation, no markdown fences.';

    let code;
    try {
        const raw = await adapter.executeModel(
            prompts.codeGen,
            { text: userPrompt },
            baseOptions
        );
        code = (typeof raw === 'string') ? raw : (raw && raw.text) || '';
    } catch (e) {
        Q.log && Q.log('AI/toolGenerate: LLM error', e.message);
        return;
    }
    if (!code || !code.trim()) return;

    const cleaned = _stripMarkdownFences(code).trim();
    if (!cleaned.startsWith('Q.Tool.define(') && !cleaned.startsWith('(function')) {
        Q.log && Q.log('AI/toolGenerate: LLM output did not look like a tool definition');
        return;
    }

    // ── 2. Verification pass (optional) ───────────────────────────────────────
    const verifyEnabled = Q.Config.get(['AI', 'commands', 'tool/generate', 'verify'], true);
    if (verifyEnabled && prompts.verify) {
        try {
            const verifyAdapter = AI_LLM.route(
                Q.Config.get(['AI', 'commands', 'tool/generate', 'verifyRoute'], 'fast'),
                { response_format: 'json' }
            );
            if (verifyAdapter) {
                const verdictRaw = await verifyAdapter.executeModel(
                    prompts.verify,
                    { text: cleaned },
                    { response_format: 'json', max_tokens: 200, temperature: 0 }
                );
                const verdictText = (typeof verdictRaw === 'string') ? verdictRaw : (verdictRaw && verdictRaw.text) || '';
                try {
                    const verdict = JSON.parse(_stripMarkdownFences(verdictText));
                    if (verdict && verdict.ok === false) {
                        Q.log && Q.log('AI/toolGenerate: verify rejected — ' + (verdict.reason || ''));
                        return;
                    }
                } catch (e) {
                    // Verifier returned unparseable JSON. Log and proceed —
                    // failing closed on a flaky verifier would silently kill
                    // valid tools; failing open with a log lets ops tune.
                    Q.log && Q.log('AI/toolGenerate: verify response was not JSON; proceeding');
                }
            }
        } catch (e) {
            Q.log && Q.log('AI/toolGenerate: verify pass error', e.message);
        }
    }

    // ── 3. Deliver to host's clients ──────────────────────────────────────────
    const slug = prompt.trim().toLowerCase()
        .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const payload = {
        toolName: 'AI/generated/' + slug,
        prompt:   prompt,
        code:     cleaned
    };

    // Socket-only to the host (not stream-ephemeral, which fan-outs to all).
    // control.js listens via Q.Socket.onEvent('AI/tool/generated').
    const Users  = state && state.Users;
    const userId = state && state.userId;
    if (Users && userId && Users.Socket && typeof Users.Socket.emitToUser === 'function') {
        Users.Socket.emitToUser(userId, 'AI/tool/generated', payload);
    } else {
        // Fallback: stream ephemeral. Reaches everyone, not ideal — but
        // better than dropping the tool entirely.
        stream.ephemeral('AI/tool/generated', payload);
    }

    Q.log && Q.log('AI/toolGenerate: delivered "' + payload.toolName + '"');
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function _stripMarkdownFences(text) {
    if (!text) return '';
    // Some models still wrap output in ```javascript ... ``` despite the
    // instruction. Strip the most common forms.
    return text
        .replace(/^\s*```(?:javascript|js|json)?\s*\n?/i, '')
        .replace(/\n?```\s*$/i, '')
        .trim();
}
