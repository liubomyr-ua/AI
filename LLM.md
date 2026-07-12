# AI Plugin — LLM Coding Primer

Supplement to Q Framework and Streams primers. Covers LLM execution, observations,
image generation, voice sessions, transcription, NER, and the intelligence pipeline.

---

## 1. LLM Execution

```php
// Route to an LLM adapter by deployment config
$llm = AI_LLM::route('smart');         // resolves via AI/llm/routes → providers
$llm = AI_LLM::route('fast');          // e.g. gpt-4o-mini
$llm = AI_LLM::route('search');        // smart + webSearch=true auto-set

// Direct adapter creation
$llm = AI_LLM::create('Anthropic', array('model' => 'claude-sonnet-4-6'));
$llm = AI_LLM::create('Openai');
$llm = AI_LLM::create('Google');

// Execute a model call (ONE RPC, no retries/batching)
$response = $llm->executeModel(
    'You are a helpful assistant.',         // instructions (system prompt)
    array(                                   // inputs (multimodal artifacts)
        'text'   => 'Describe this image',
        'images' => array($binaryImageData), // raw binary, not URLs
        'pdfs'   => array($binaryPdfData)    // Claude 3.5+ documents
    ),
    array(                                   // options
        'model'       => 'claude-sonnet-4-6',  // override default
        'temperature' => 0.7,
        'max_tokens'  => 2000,
        'messages'    => array(              // conversation timeline
            array('role' => 'user',      'content' => 'Previous question'),
            array('role' => 'assistant', 'content' => 'Previous answer'),
            array('role' => 'user',      'content' => 'Follow-up')
        ),
        'response_format' => 'json_schema',  // structured output
        'json_schema'     => $schema,        // JSON Schema object
        'schema_name'     => 'my_output',
        'callback'        => function($result) { /* async handler */ }
    )
);
// Returns string (sync) or integer request index (async/batch)

// Web search (adapter must supportsWebSearch())
$result = $llm->searchAndRespond(
    'Answer using current sources.',
    'Latest AI regulation news',
    array('webSearch' => true, 'includeCitations' => true)
);
// Returns string or {text, citations[]}

// List configured routes and providers
$routes = AI_LLM::listRoutes();       // ['smart', 'fast', 'search', ...]
$providers = AI_LLM::listProviders(); // ['anthropic-direct', 'openai-direct', ...]
```

**JS (Node.js) — identical pattern:**
```js
var AI_LLM = require('AI/LLM');
var llm = AI_LLM.route('smart');
var result = await llm.executeModel(instructions, inputs, options);
```

---

## 2. Observations

```php
// Process multimodal inputs through config-driven observations
$observations = AI_LLM::observations('Streams/image', 'holiday');
// Loads from observations.json: {semanticExtraction, holidayAnalysis, ...}

$results = $llm->process(
    array('images' => array($imageData)),  // inputs
    $observations,                          // observation definitions
    array('currentYear' => date('Y')),     // interpolation vars
    array('structured' => true)             // use native structured outputs
);
// Returns: {semanticExtraction: {title, holidayName, startDate, ...}, ...}

// Create a stream from observation results (with policy gate)
$stream = AI_LLM::createStream(
    'Streams/image',           // stream type
    'holiday',                 // observation type
    array('icon' => $iconUrl), // stream creation data
    $results,                  // LLM observation results
    array(
        'publisherId' => $communityId,
        'accept'      => true  // or callable; default rejects obscene/controversial
    )
);
// Returns Streams_Stream or false if policy gate rejects

// Extract flat attributes from observation results
$attributes = AI_LLM::attributesFromObservationResults(
    $results, 'Streams/image', 'holiday'
);
// Returns: {title, holidayName, startDate, countries, ...}

// Build prompt + schema from observation definitions
$o = AI_LLM::promptFromObservations($observations);
// Returns: {clauses: [...], schema: {...}}

// Build strict JSON Schema from observations
$schema = AI_LLM::jsonSchemaFromObservations($observations);
// Returns: full JSON Schema with types, required, additionalProperties:false
```

**Observation definition format (observations.json):**
```json
{
    "Streams/image": {
        "holiday": {
            "semanticExtraction": {
                "promptClause": "Extract visible text, identify holiday...",
                "fieldNames": ["title", "holidayName", "startDate", "endDate"],
                "example": { "title": "Happy Valentine's Day", "startDate": "2026-02-14" }
            },
            "contentClassification": {
                "promptClause": "Classify content type, occasion, tone...",
                "fieldNames": ["contentType", "occasion", "tone", "sentiment"],
                "example": { "contentType": "greeting card", "tone": "cheerful" }
            }
        }
    }
}
```

---

## 3. Named Entity Recognition (No LLM Cost)

```php
// Lightweight regex NER — runs before LLM calls
$entities = AI_LLM::extractEntities($transcriptText);
// Returns: {
//   persons:  ['Tim Cook', 'Elon Musk'],
//   orgs:     ['NVIDIA', 'OpenAI', 'Google AI'],
//   topics:   ['artificial intelligence', 'chip shortage'],
//   numbers:  [{value: '100', unit: 'billion', raw: '100 billion'}, ...],
//   hashtags: ['AI', 'tech']
// }

// Build search queries from entities (no LLM cost)
$queries = AI_LLM::buildSearchQueries($entities, 'AI conference');
// Returns: ['Tim Cook AI conference', 'Tim Cook', 'NVIDIA AI conference', ...]

// Match entities against Qbix avatars (database lookup, no LLM)
$avatars = AI_LLM::lookupStreams(
    array('Tim Cook', 'Elon Musk'),
    array('limit' => 3, 'public' => true)
);
// Returns: {publisherId => Streams_Avatar, ...}
```

---

## 4. Summarization & Keywords

```php
// Summarize text
$result = $llm->summarize($longText);
// Returns: {title, keywords: [...], summary, speakers}

// Expand keywords for search indexing
$expanded = $llm->keywords(
    array('machine learning', 'neural network'),
    'insert',                          // 'insert' (broad) or 'query' (narrow)
    array('language' => 'es'),         // multilingual expansion
    $keywordsNative                    // filled with Spanish keywords
);
// Returns: ['machine learning', 'deep learning', 'ML', 'neural net', ...]
// $keywordsNative: ['aprendizaje automático', 'red neuronal', ...]
```

---

## 5. Image Generation

```php
// Create image adapter via config
$img = AI_Image::create('openai');    // or 'aws', 'google', 'ideogram'

// Generate image
$result = $img->generate('A serene mountain landscape', array(
    'model'  => 'dall-e-3',
    'width'  => 1024,
    'height' => 1024,
    'format' => 'png',
    'images' => array($referenceImage) // optional reference for style transfer
));
// Returns: {data: binary, format: 'png'} or {b64_json: '...'}

// Remove background
$result = $img->removeBackground($imageData, array(
    'background' => 'transparent',
    'format'     => 'png'
));
```

---

## 6. Realtime Voice Sessions

```php
// Broker a realtime voice session
$broker = AI_Voice::route('conversational');
$session = $broker->createSession(array(
    'voice'          => 'alloy',
    'instructions'   => 'You are a helpful assistant.',
    'turn_detection' => array('type' => 'server_vad'),
    'tools'          => array(/* function definitions */),
    'audioFormat'    => 'pcm16',
    'sampleRate'     => 24000
));
// Returns: {
//   token: 'eph_...', wsUrl: 'wss://...', protocol: 'openai-realtime',
//   model: 'gpt-4o-realtime-preview', expiresAt: 1234567890,
//   mode: 'direct'  // browser connects to provider directly
// }
// Return $session to browser → AI.Voice.connect(session)

// Protocols: 'openai-realtime', 'gemini-live', 'pipecat', 'livekit'
// Mode 'proxy': server relays audio (Gemini Live, no client-safe tokens)
```

---

## 7. Transcription

```php
// Async transcription (webhook-based)
$transcriber = AI_Transcription::create('assemblyai');
$result = $transcriber->transcribe($audioUrl, array(
    '_diarization' => array('max' => 5)  // speaker detection
));
// Returns: transcript ID for later fetch

// Fetch completed transcript
$transcript = $transcriber->fetch($transcriptId);

// Realtime streaming: AI.speech.provider = 'deepgram'
// Client sends mic audio via Qbix socket → DeepgramStream on Node.js
// Config: AI.transcription.deepgram.key, endpointing, interimResults
```

---

## 8. Discourse Integration

```php
// AI-powered forum reply with attitude selection
// POST to AI/discourse with:
// userId, apiKey, topicUrl, attitude, language

// Available attitudes:
// 'agree + actionable'    — agreement + insights
// 'agree + emotive'       — enthusiastic agreement
// 'agree + expand'        — agree then broaden scope
// 'agree + changeSubject' — agree then pivot to bigger issue
// 'disagree + respectful' — polite counterarguments
// 'disagree + emotive'    — opinionated with aphorisms
// 'disagree + absurd'     — sarcastic analogies
// 'disagree + authority'  — cite respected authorities
```

---

## 9. Stream Commands

```php
// Registered in Streams.commands.AI config:
// AI/image/generate  — routing: 'background'  — generates images
// AI/tool/generate   — routing: 'veto'        — generates tools
// AI/slide/generate  — routing: 'veto'        — AI-composed HTML slides

// Commands are dispatched via Streams command system
// 'veto' routing means proposals can be vetoed before execution
// 'background' routing means execution happens asynchronously
```

---

## 10. Common Mistakes

| Wrong | Right |
|-------|-------|
| Calling provider APIs directly | Use `AI_LLM::route('smart')` — provider-agnostic, deployment-configurable |
| Passing image URLs in inputs | Pass raw binary data in `inputs.images`; adapters handle encoding |
| Adding retries/batching in adapter code | Adapters do ONE RPC only; orchestration belongs in higher layers |
| Hardcoding model names | Set model in `AI/llm/providers/{name}/config`; override via options |
| Using `process()` without observations | `process()` requires observation definitions; use `executeModel()` for freeform |
| Skipping the policy gate in `createStream()` | Default `accept()` rejects obscene > 3, controversial > 5, confidence < 0.6 |
| Running NER via LLM | Use `extractEntities()` first (regex, free); LLM disambiguates the candidates |
| Storing voice tokens server-side | Voice tokens are ephemeral — send to browser, browser connects directly |
| Forgetting `offline.access` scope for voice | Realtime voice uses ephemeral tokens, not OAuth — no scope needed |
| Using `makeStrict()` for Gemini schemas | Use `geminiSchema()` — Gemini rejects `additionalProperties` |

---

## 11. Configuration Reference

```
AI.llm.default                    — fallback provider name
AI.llm.providers.{name}.class     — adapter class (Anthropic, Openai, Google, Aws, VertexAi, Local)
AI.llm.providers.{name}.config    — model, apiKey overrides
AI.llm.routes.{name}              — route → provider mapping (smart, fast, search, vision)
AI.llm.structuredOutputs          — enable native structured outputs globally

AI.anthropic.apiKey               — Anthropic direct API key
AI.anthropic.baseUrl              — defaults to https://api.anthropic.com
AI.openAI.key                     — OpenAI API key
AI.google.key                     — Google AI Studio key
AI.aws.region                     — AWS Bedrock region

AI.image.default                  — default image provider
AI.image.providers.{name}         — model and options per provider
AI.voice.provider                 — voice provider (openai, elevenlabs, google, null)
AI.voice.key                      — voice provider API key
AI.speech.provider                — client STT (deepgram, browser, null)
AI.speech.sampleRate              — mic sample rate (default 16000)
AI.transcription.provider         — server STT (assemblyai, deepgram, null)
AI.transcription.deepgram.key     — Deepgram API key
AI.transcription.assemblyai.key   — AssemblyAI API key
AI.observations.{plugin}          — observations JSON file path per plugin
```