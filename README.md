# AI Plugin

Qbix AI plugin. Provides LLM, image, transcription, and realtime voice provider adapters with config-driven routing.

## What's new in this round

### Cloud-neutral LLM routing

`AI_LLM::route('smart')` (PHP) and `AI_LLM.route('smart')` (JS) resolve a logical route name to the deployment-configured backend. Consumers don't need to know if smart-routed LLM is Anthropic-direct, Anthropic-on-Bedrock, Anthropic-on-Vertex, OpenAI, Gemini, or local Llama. Configure once per deployment; consumers stay portable.

New LLM adapters this round (PHP + JS twins for sandbox-callable):

- **`AI_LLM_Anthropic`** — direct api.anthropic.com. Implements `AI_LLM_AdvancedInterface` for prompt caching via `cache_control`.
- **`AI_LLM_VertexAi`** — Google Cloud Vertex AI. Auto-dispatches by model name's publisher segment to Gemini / Anthropic-on-Vertex / Llama-on-Vertex. Auth via service account JSON, pre-acquired access token, or Workload Identity metadata server.
- **`AI_LLM_Local`** — OpenAI-compatible local servers (vLLM, llama-cpp-server, Ollama, LM Studio, generic). Subtype dispatch for KV-cache control: prefix caching, prewarm, list, evict. SSRF allowlist guards against config-drift attacks against arbitrary internal hosts.

Plus the existing `AI_LLM_Openai`, `AI_LLM_Aws` (Bedrock), `AI_LLM_Google` (AI Studio Gemini).

See `config/AI-sample.json` for a complete routing example and `ADAPTER_GUIDE.md` for adding new providers.

### Two-tier interface

```php
$llm = AI_LLM::route('smart');

// Common surface — works for all providers
$resp = $llm->executeModel($systemPrompt, $inputs, $options);

// Advanced surface — for providers that implement AI_LLM_AdvancedInterface
if ($llm instanceof AI_LLM_AdvancedInterface) {
    $resp = $llm->executeWithCachedPrefix('cache-key', $systemPrefix, $inputs, $options);
}
if ($llm instanceof AI_LLM_AdvancedInterface && $llm->supportsPrefixCache()) {
    $llm->prewarmPrefix('cache-key', $systemPrefix);
}
```

Hosted providers (Anthropic, Vertex Anthropic) partially implement Advanced — they support `executeWithCachedPrefix` via the provider's native cache_control, but throw `AI_LLM_Exception_NotSupported` for `prewarmPrefix`, `listCachedPrefixes`, `dropCachedPrefix` because the underlying API doesn't expose those.

Local providers fully implement Advanced when subtype is `vllm`, `llama-cpp`, or `sglang`. Generic OpenAI-compat and Ollama subtypes are second-class — `supportsPrefixCache()` returns false and the advanced methods fall back to plain execution or throw NotSupported.

### Realtime voice layer

New category for realtime speech-to-speech voice agents. Architecturally different from batch LLM: the audio flows over a persistent WebSocket or WebRTC connection between the browser/iframe and the provider, not through the server.

Server-side broker (PHP) issues ephemeral tokens. Browser-side client (JS) speaks the provider's session protocol.

Server-side adapters:

- **`AI_Voice_Openai`** — OpenAI Realtime API. WebRTC preferred for browsers, WebSocket for server-to-server. Ephemeral tokens via `POST /v1/realtime/client_secrets`.
- **`AI_Voice_AzureOpenai`** — Azure OpenAI Service Realtime. Same wire format as OpenAI but Azure region endpoints + Entra ID or api-key auth.
- **`AI_Voice_Xai`** — xAI Grok Voice Think Fast 1.0. OpenAI-Realtime wire-compatible. WebSocket-only (no WebRTC as of May 2026). Subprotocol-based token auth.
- **`AI_Voice_Gemini`** — Google Gemini Live API. Different wire format (`setup`/`clientContent`/`realtimeInput`/`serverContent`). Operates in **proxy mode** — your server forwards to Gemini using server-side auth, since Gemini doesn't issue client-safe ephemeral tokens.
- **`AI_Voice_Local`** — self-hosted gateway (Pipecat or LiveKit Agents). Mints HMAC-signed JWT tokens; your gateway validates them on connect. SSRF allowlist for the gateway URL.

Browser-side client:

```javascript
// 1. Server returns the session object to the browser:
//    { token, wsUrl, wrtcUrl, protocol, model, expiresAt, mode, session, ... }
var session = await fetch('/api/voice/session', { method: 'POST' }).then(r => r.json());

// 2. Browser code:
var voice = new AI.Voice(session);

voice.on('open',      ()      => console.log('voice ready'));
voice.on('audio',     b64chunk => playAudioChunk(b64chunk));
voice.on('transcript', t      => {
    // t.role: 'user' | 'assistant'
    // t.text: string (delta)
    // t.isFinal: boolean
    console.log(`[${t.role}] ${t.text}`);
});
voice.on('toolCall',  call    => {
    const result = await handleTool(call.name, call.arguments);
    voice.respondToToolCall(call.callId, result);
});
voice.on('error',     err     => console.error(err));

await voice.connect();
await voice.startMicrophone();  // browser captures and forwards audio
// ... user talks; events flow ...
voice.sendText('Switch language to Spanish, please.');
voice.close();
```

The `AI.Voice` class dispatches to a per-protocol implementation based on `session.protocol`:

- `openai-realtime` → `AI.Voice.OpenaiRealtime` (handles OpenAI + xAI + Azure)
- `gemini-live` → `AI.Voice.GeminiLive`
- `pipecat` → `AI.Voice.Pipecat`
- `livekit` → `AI.Voice.LiveKit` (requires livekit-client SDK loaded)

### iframe / postMessage bridge

For embedded use:

```javascript
// In iframe page:
AI.Voice.attachPostMessageBridge(window.parent, 'https://parent.example.com');

// In parent page:
iframe.contentWindow.postMessage({
    type: 'voice.connect',
    session: sessionObject
}, '*');
iframe.contentWindow.postMessage({ type: 'voice.startMic' }, '*');

window.addEventListener('message', e => {
    if (e.data.type === 'voice.transcript') console.log(e.data.text);
    if (e.data.type === 'voice.toolCall') handleTool(e.data);
});
```

This lets a parent app drive a voice session inside an embedded iframe without each iframe needing its own provider keys.

## Routing config

See `config/AI-sample.json` for a complete example with all providers.

Pattern:

```json
{
    "AI": {
        "llm": {
            "default": "anthropic-direct",
            "providers": {
                "anthropic-direct":  { "class": "Anthropic", "config": {...} },
                "anthropic-vertex":  { "class": "VertexAi",  "config": {...} },
                "openai-direct":     { "class": "Openai",    "config": {...} },
                "llama-vllm-local":  { "class": "Local",     "config": {...} }
            },
            "routes": {
                "smart":        "anthropic-direct",
                "smart-cached": "llama-vllm-local",
                "fast":         "openai-direct",
                "long-context": "anthropic-vertex"
            }
        },
        "voice": {
            "default": "openai-realtime",
            "providers": {
                "openai-realtime": { "class": "Openai", "config": {...} },
                "xai-grok-voice":  { "class": "Xai",    "config": {...} },
                "gemini-live":     { "class": "Gemini", "config": {...} },
                "local-pipecat":   { "class": "Local",  "config": {...} }
            },
            "routes": {
                "conversational": "openai-realtime",
                "reasoning":      "xai-grok-voice",
                "local":          "local-pipecat"
            }
        }
    }
}
```

A deployment running on GCP would set `anthropic-vertex` as default; on AWS, `anthropic-bedrock`; on Azure, `anthropic-direct` or `azure-openai`. The application code calling `AI_LLM::route('smart')` doesn't change.

## What's NOT in this round

Honest scope notes:

- **No real-endpoint testing.** All code is syntax-clean and built against documented provider specs (cross-referenced May 2026), but none has been run against live endpoints. Expect debugging when you integrate. Likely failure surfaces: header names, payload field casing, response shape variation between providers' beta/GA versions.
- **No Azure AI Foundry, Oracle Generative AI, or watsonx.ai LLM adapters yet** — the Azure/Oracle/IBM long tail. Add them following `ADAPTER_GUIDE.md`.
- **No image-generation routing yet.** Existing `AI_Image_*` adapters work; new providers (Vertex Imagen, Stability direct, Azure DALL-E, local SD) aren't wired into a router. Same pattern applies; future round.
- **No transcription routing yet.** Same deferral.
- **Voice provider catalog is current as of May 2026.** Anthropic does NOT publish a realtime voice API. If you need Claude as voice, pipeline through Pipecat: STT → Claude → TTS. Or wait for Anthropic to ship one.
- **OpenAI's WebRTC SDP renegotiation when adding mic track post-connect.** The protocol client adds the track but may need explicit renegotiation in some browsers. Most browsers handle implicitly via `onnegotiationneeded`; if your case breaks, the fix is calling `pc.setLocalDescription(await pc.createOffer())` after `addTrack`.
- **Pipecat wire format assumed defaults.** Your Pipecat deployment may publish events differently. Customize `AI.Voice.Pipecat._handleEvent` for your event vocabulary, or use LiveKit transport instead.

## Adding new providers

See `ADAPTER_GUIDE.md` for the pattern. Pair every PHP adapter with a JS adapter for sandbox-callable use. Test against real endpoints before shipping.
