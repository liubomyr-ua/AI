# AI Plugin

Provider-agnostic AI infrastructure for the Qbix platform — LLM execution, image generation, realtime voice, speech-to-text transcription, structured observation processing, and a live transcript intelligence pipeline. The plugin defines clean interface contracts for each capability and routes through deployment-configured provider adapters, so application code never touches provider-specific APIs directly.

## Core Concepts

### LLM Execution

`AI_LLM` defines a single primitive: `executeModel($instructions, $inputs, $options)` — exactly one RPC per call, no retries, no batching, no orchestration. The interface abstracts the conversation semantics across providers: system/developer instructions map to OpenAI's `instructions`, Anthropic's `system`, and Gemini's `system_instruction`. Messages use a canonical `{role, content}` shape that adapters translate.

The `$inputs` array carries multimodal artifacts — images, PDFs, audio, video, and arbitrary artifacts — as binary data, not URLs. The `$options` array carries execution parameters (model, temperature, max_tokens, response_format, json_schema) and the conversation timeline (messages array with user/assistant/tool roles).

**Factory and routing.** `AI_LLM::create($adapter)` instantiates an adapter by class name. `AI_LLM::route($routeName)` resolves a deployment-configured route (e.g. "smart", "fast", "search", "vision") to a provider definition (class + config) and returns an instance with merged options. Route names are deployment conventions — the same application code runs against Anthropic direct, AWS Bedrock, Google Vertex AI, or a local vLLM server by changing config.

**Provider adapters:** Anthropic (direct API with prompt caching via `AI_LLM_AdvancedInterface`), OpenAI (Responses API), Google (Gemini via AI Studio or Vertex), AWS (Bedrock), VertexAI (Anthropic, Gemini, and Llama on Vertex), Local (vLLM and compatible OpenAI-compat servers). Each adapter lives in `AI/LLM/{Adapter}.php` and `AI/LLM/{Adapter}.js` with identical factory semantics on both sides.

**Web search.** Adapters that support built-in web search declare `supportsWebSearch() = true` and accept `options.webSearch` (true or `{maxUses, contextSize, allowedDomains, userLocation}`). The `"search"` route implies webSearch automatically. `searchAndRespond($instructions, $query)` provides a high-level helper.

**Structured outputs.** `options.response_format = 'json_schema'` with `options.json_schema` engages provider-native constrained decoding. `AI_LLM::makeStrict()` normalizes schemas for strict-mode providers. `AI_LLM::geminiSchema()` strips `additionalProperties` for Gemini's OpenAPI-subset.

### Observations System

Observations are config-driven semantic evaluators. Each observation defines a `promptClause` (what to evaluate), `fieldNames` (output fields), and an optional `example` (for schema inference). Observations are loaded from JSON files via `AI.observations` config and processed via `AI_LLM::process($inputs, $observations)`.

The process method builds a structured prompt with all observation clauses and a JSON schema, sends it to the LLM, and returns typed results. `AI_LLM::promptFromObservations()` generates the prompt and example schema. `AI_LLM::jsonSchemaFromObservations()` generates a strict JSON Schema for constrained decoding. Observations support interpolation via `Q::interpolate()` with variables like `{{currentYear}}`, `{{communityId}}`.

The built-in observation set (`config/observations.json`) covers image analysis: basic description (title + content), holiday detection (semantic extraction, holiday importance, timing), language quality (spelling, expressions), cultural relevance (countries, specificity), content classification (type, occasion, tone, sentiment), aesthetic quality, and safety flags (obscene, controversial, confidence).

`AI_LLM::createStream()` ties it together: runs observations, filters through a policy gate (`accept()` rejects obscene > 3, controversial > 5, confidence < 0.6), and creates a Qbix stream with the observation results as attributes.

### Named Entity Recognition

`AI_LLM::extractEntities($text)` provides lightweight regex-based NER that runs before any LLM call, returning `{persons, orgs, topics, numbers, hashtags}`. Persons are detected via Title Case word sequences with stopword filtering. Orgs match known suffixes (Inc, Corp, LLC, Labs, AI, etc.) and all-caps acronyms. Numbers capture values with units (billion, percent, etc.). Topics follow indicator words (about, discussing, regarding).

`AI_LLM::buildSearchQueries($entities)` converts extracted entities into priority-ordered search queries for Pexels/Pixabay/archive lookups — no LLM cost. `AI_LLM::lookupStreams($names)` matches entity names against Qbix `Streams_Avatar` rows via prefix search for cheap entity linking.

### Summarization & Keywords

`AI_LLM::summarize($text)` extracts title, keywords, summary, and speakers from text using XML-tagged output. `AI_LLM::keywords($keywords, $during)` expands canonical keywords into related search terms — broader during insert time, narrower during query time. Supports multilingual expansion with native-language output.

### Image Generation

`AI_Image` defines `generate($prompt, $options)` and `removeBackground($image, $options)`. Adapters: OpenAI (DALL-E 3), AWS (Bedrock Stable Diffusion), Google (Vertex AI with transparent background support), Hotpotai, Ideogram, Removebg. The factory and routing follow the same `create()`/`route()` pattern as LLM.

### Realtime Voice

`AI_Voice` brokers realtime voice sessions. The server issues ephemeral tokens scoped to a session configuration (voice, instructions, VAD, tools), and the browser connects directly to the provider — the server never proxies audio. `createSession($params)` returns `{token, wsUrl, protocol, model, expiresAt, mode}`. The `protocol` field drives client-side dispatch to the correct `AI.Voice.<Protocol>` class.

Adapters: OpenAI Realtime (`openai-realtime` protocol), Gemini Live (`gemini-live`, proxy mode since Gemini doesn't issue client-safe tokens), Elevenlabs, Pipecat, LiveKit, Azure OpenAI. Client-side adapters in `web/js/AI/Voice/` handle WebSocket/WebRTC connection per protocol.

### Transcription (Speech-to-Text)

`AI_Transcription` defines `transcribe($source, $options)` and `fetch($transcriptId)`. Adapters: AssemblyAI (with webhook-based async), OpenAI (Whisper), AWS, Xai. For realtime streaming, `AI_Transcription_DeepgramStream` and `AI_Transcription_AssemblyaiStream` run on the Node.js process, receiving mic audio via the Qbix socket.

Client-side speech recognition is configured via `AI.speech.provider`: `"deepgram"` routes mic audio through the socket server; `"browser"` or null uses native `SpeechRecognition`. Config: `sampleRate` (default 16000), `chunkMs` (default 100).

### Intelligence Pipeline

`AI/Pipeline.js` implements a live transcript intelligence pipeline: NER → fast lookup → cached LLM query → proposal. It uses a schema-driven prompt system (`AI/Prompt.js` builds prompts from `messages.schema.json`) with KV cache optimization — the ~2900-token static schema prefix is byte-stable across calls and cached at 0.1× price on Anthropic (5-min TTL). The per-call dynamic part (role, context, intent constraint) is only ~20–60 tokens.

Intent detection uses regex heuristics: comparison, definition, statistics, slide generation, map/directions, and wake word detection. The pipeline emits proposals that can be vetoed (via `AI/VetoQueue.js`) before execution.

### Session Management

`AI/Session.js` maintains per-socket AI session state with a 60-second grace period for reconnection. Sessions are keyed by both socket ID (current binding) and session token (stable identity). On reconnect, the session rebinds to the new socket without losing state.

### Discourse Integration

`AI/discourse/post.php` generates AI-powered forum replies with selectable attitudes: agree+actionable, agree+emotive, agree+expand, agree+changeSubject, disagree+respectful, disagree+emotive, disagree+absurd, disagree+authority. Posts the generated reply back to the Discourse forum and saves a record to Streams.

### Stream Commands

The plugin registers Streams commands for AI-powered content generation: `AI/image/generate` (background routing), `AI/tool/generate` (veto routing), `AI/slide/generate` (veto routing — AI-composed HTML slides with web search images).

## Provider Adapters

| Subsystem | Adapters |
|---|---|
| LLM | Anthropic, OpenAI, Google, AWS (Bedrock), VertexAI, Local |
| Image | OpenAI (DALL-E), AWS, Google, Hotpotai, Ideogram, Removebg |
| Voice | OpenAI Realtime, Gemini Live, Elevenlabs, Pipecat, LiveKit, Azure OpenAI |
| Transcription | AssemblyAI, OpenAI, AWS, Xai, DeepgramStream, AssemblyaiStream |

## Database

No custom tables. Observation results are stored as stream attributes. Pipeline state uses Streams infrastructure. Session state is in-memory (Node.js process).

## Configuration

```json
{
    "AI": {
        "llm": {
            "default": "anthropic-direct",
            "providers": {
                "anthropic-direct": { "class": "Anthropic", "config": { "model": "claude-sonnet-4-6" } },
                "openai-direct":    { "class": "Openai",    "config": { "model": "gpt-4.1-mini" } },
                "gemini-vertex":    { "class": "VertexAi",  "config": { "model": "publishers/google/models/gemini-2.5-pro" } }
            },
            "routes": { "smart": "anthropic-direct", "fast": "openai-direct", "search": "anthropic-direct" }
        },
        "image":  { "default": "openai", "providers": { "openai": { "model": "dall-e-3" } } },
        "voice":  { "provider": "openai" },
        "speech": { "provider": "deepgram", "sampleRate": 16000, "chunkMs": 100 },
        "transcription": { "provider": "assemblyai" },
        "anthropic": { "apiKey": "..." },
        "openAI":    { "key": "..." }
    }
}
```