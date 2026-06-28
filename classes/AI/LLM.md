# AI_LLM API Documentation (PHP & JavaScript)

Complete reference for Large Language Model execution, observations, and semantic processing across providers.

---

## Table of Contents

1. [Overview](#overview)
2. [Core Design](#core-design)
3. [Factory & Routing](#factory--routing)
4. [Execution Model](#execution-model)
5. [Observations Pipeline](#observations-pipeline)
6. [NER & Search Helpers](#ner--search-helpers)
7. [High-Level Utilities](#high-level-utilities)
8. [Web Search](#web-search)
9. [Configuration](#configuration)
10. [Examples](#examples)

---

## Overview

The AI_LLM system provides a **provider-agnostic execution layer** for Large Language Models across multiple backends:

- **OpenAI** (GPT-4, GPT-4o, o1)
- **Anthropic Claude** (Claude 3.5 Sonnet, Claude 3 Opus)
- **Google Gemini** (Gemini 2.5, Pro, Flash)
- **AWS Bedrock** (Claude via Bedrock, Titan, etc.)

**Key principles:**

1. **Single RPC per call** — `executeModel()` is the only primitive
2. **No orchestration** — Higher layers handle retries, batching, tool execution
3. **Observation-driven** — Structured output schema for semantic processing
4. **NER-first pipeline** — Lightweight regex extraction before LLM calls
5. **Web search capable** — Built-in providers support live internet access

**Available across:**
- PHP: `classes/AI/LLM.php` and `classes/AI/LLM/<Adapter>.php`
- JavaScript: `modules/AI/LLM.js` and `modules/AI/LLM/<Adapter>.js`

---

## Core Design

### Message Chronology

Modern LLMs operate on an **ordered timeline of messages**. This interface normalizes conversation structure across providers:

**Logical Hierarchy:**
```
system / developer instructions  (highest precedence)
    ↓
tool outputs
    ↓
assistant messages
    ↓
user messages
```

**Provider Mappings:**

| Concept | OpenAI | Claude | Gemini |
|---------|--------|--------|--------|
| System | `instructions` | `system` | `system_instruction` |
| User Message | `role: "user"` | `role: "user"` | `role: "user"` |
| Assistant | `role: "assistant"` | `role: "assistant"` | `role: "model"` |
| Tool Output | `role: "tool"` | `type: "tool_result"` | Tool parts |

The interface abstracts these differences — adapters handle translation.

### Multimodal Inputs

Inputs are external artifacts (not conversational messages):

**Canonical Structure:**

```php
// PHP
[
    'images' => [binary_data1, binary_data2],
    'pdfs' => [binary_data],
    'audio' => [binary_data],
    'video' => [binary_data],
    'artifacts' => [custom_data1, custom_data2]
]
```

```javascript
// JavaScript
{
    images: [binaryData1, binaryData2],
    pdfs: [binaryData],
    audio: [binaryData],
    video: [binaryData],
    artifacts: [customData1, customData2]
}
```

---

## Factory & Routing

### Direct Adapter Creation: `create()`

**PHP:**
```php
$llm = AI_LLM::create($adapter, $options);
```

**JavaScript:**
```javascript
var llm = AI_LLM.create(adapter, options);
```

**Parameters:**
- `$adapter` (string|object): Adapter name ("openai", "anthropic", "google", "aws"), full class name, or existing instance
- `$options` (array): Optional constructor parameters

**Returns:** LLM adapter instance or null

**Examples:**

PHP:
```php
$llm = AI_LLM::create('anthropic');
$llm = AI_LLM::create('google');
$llm = AI_LLM::create('AI_LLM_Openai', ['model' => 'gpt-4o']);
```

JavaScript:
```javascript
var llm = AI_LLM.create('anthropic');
var llm = AI_LLM.create('google');
```

### Deployment Routing: `route()`

Route to a configured adapter by **logical name**, not provider name. Enables swapping backends without code changes.

**Configuration:**

PHP/JavaScript config syntax:
```
AI: {
  llm: {
    default: "fast-default",
    routes: {
      smart: "anthropic-direct",
      "smart-cached": "llama-vllm",
      fast: "openai",
      vision: "anthropic-direct",
      search: "anthropic-direct"
    },
    providers: {
      "anthropic-direct": {
        class: "Anthropic",
        config: {model: "claude-3-5-sonnet-20241022", temperature: 0.7}
      },
      "llama-vllm": {
        class: "Local",
        config: {subtype: "vllm", model: "meta-llama/Llama-3.1-70B-Instruct"}
      },
      "openai": {
        class: "Openai",
        config: {model: "gpt-4o-mini", temperature: 0.5}
      }
    }
  }
}
```

**Usage:**

PHP:
```php
$smart = AI_LLM::route('smart');      // returns Anthropic instance
$fast  = AI_LLM::route('fast');       // returns OpenAI instance
$search = AI_LLM::route('search');    // returns Anthropic; webSearch forced on
```

JavaScript:
```javascript
var smart = AI_LLM.route('smart');
var fast = AI_LLM.route('fast');
var search = AI_LLM.route('search', {webSearch: true});  // explicit override
```

**Resolution Logic:**

1. Check `routes[routeName]` → provider name
2. Fallback to `default` provider
3. Fallback to first provider in list
4. Return null if none found

**Special Behavior:**

The `'search'` route automatically enables `webSearch: true` unless the caller explicitly overrides it.

### Listing Routes & Providers

**PHP:**
```php
$routes = AI_LLM::listRoutes();      // ['smart', 'fast', 'vision', ...]
$providers = AI_LLM::listProviders(); // ['anthropic-direct', 'openai', ...]
```

**JavaScript:**
```javascript
var routes = AI_LLM.listRoutes();
var providers = AI_LLM.listProviders();
```

---

## Execution Model

### `executeModel($instructions, $inputs, $options)`

The **single primitive** — one model invocation, exactly.

**Parameters:**

**`$instructions` (string)**

System/developer instructions defining rules, schemas, task framing, and constraints. Maps to:
- OpenAI: `instructions`
- Claude: `system`
- Gemini: `system_instruction`

**`$inputs` (array)**

Multimodal artifacts (images, PDFs, audio, custom data). Structured as described above.

**`$options` (array)**

Conversation & execution config:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `messages` | array | null | Ordered message list (role, content, name) |
| `model` | string | config | Provider model name |
| `temperature` | number | 0.7 | Sampling temperature (0.0–2.0) |
| `max_tokens` | number | 1000 | Max output tokens |
| `response_format` | string | "text" | "text", "json", or "json_schema" |
| `json_schema` | object | null | JSON Schema (when response_format="json_schema") |
| `schema_name` | string | "response" | Schema name (some providers require) |
| `timeout` | number | 30 | Request timeout (seconds) |
| `callback` | callable | null | Async callback handler |
| `webSearch` | bool\|object | false | Enable web search (see Web Search section) |

**Returns:**

- Sync: string (model output text)
- Async: integer (request index)

**Example:**

PHP:
```php
$llm = AI_LLM::create('anthropic');
$result = $llm->executeModel(
    'You are a helpful assistant.',
    ['text' => 'Hello'],
    ['temperature' => 0.7, 'max_tokens' => 500]
);
```

JavaScript:
```javascript
var llm = AI_LLM.create('anthropic');
llm.executeModel('You are a helpful assistant.', {text: 'Hello'}, {
    temperature: 0.7,
    max_tokens: 500
}).then(function(result) {
    console.log(result);
});
```

---

## Observations Pipeline

Observations are **local, per-artifact semantic evaluators** that extract structured data from unstructured inputs.

### Observation Definition

**Schema:**

```php
$observations = [
    'observationName' => [
        'promptClause' => 'Extract the main topic discussed',
        'fieldNames' => ['topic', 'confidence'],
        'example' => ['topic' => 'AI', 'confidence' => 0.9]
    ]
];
```

### `process($inputs, $observations, [$interpolate, $options])`

Run ONE model call that produces structured JSON matching observation schema.

**Parameters:**

- `$inputs` (array): Multimodal input (text, images, etc.)
- `$observations` (array): Observation definitions (schema above)
- `$interpolate` (array, optional): Placeholder substitutions for prompt
- `$options` (array, optional): Execution options (model, temperature, etc.)

**Returns:** Parsed JSON object matching observation schema

**Example:**

PHP:
```php
$llm = AI_LLM::create('anthropic');
$result = $llm->process(
    ['text' => 'Apple released iPhone 16 with new chips.'],
    [
        'entityExtraction' => [
            'promptClause' => 'Extract all named entities (organizations, products, technologies)',
            'fieldNames' => ['orgs', 'products', 'technologies'],
            'example' => ['orgs' => ['Apple'], 'products' => ['iPhone 16'], 'technologies' => ['chips']]
        ]
    ]
);
// result: {
//   entityExtraction: {
//     orgs: ['Apple'],
//     products: ['iPhone 16'],
//     technologies: ['chips']
//   }
// }
```

JavaScript:
```javascript
var llm = AI_LLM.create('anthropic');
llm.process(
    {text: 'Apple released iPhone 16 with new chips.'},
    {
        entityExtraction: {
            promptClause: 'Extract all named entities (organizations, products, technologies)',
            fieldNames: ['orgs', 'products', 'technologies'],
            example: {orgs: ['Apple'], products: ['iPhone 16'], technologies: ['chips']}
        }
    }
).then(function(result) {
    console.log(result.entityExtraction);
});
```

### Schema Helpers

**`jsonSchemaFromObservations($observations)`**

Build a strict JSON Schema from observations for provider-native structured outputs.

PHP:
```php
$schema = AI_LLM::jsonSchemaFromObservations($observations);
// Pass to options['json_schema'] for Claude, OpenAI structured outputs
```

**`makeStrict($schema)`**

Normalize schema for strict mode (additionalProperties: false, all fields required).

**`geminiSchema($schema)`**

Sanitize schema for Gemini's responseSchema field (removes additionalProperties, preserves type/properties/required).

---

## NER & Search Helpers

Lightweight regex-based extraction — **no LLM cost**.

### `extractEntities($text)`

Extract typed named entities using regex patterns.

**Returns:**

```php
[
    'persons' => ['Alice Smith', 'Bob Johnson'],
    'orgs' => ['Google', 'NVIDIA', 'APPL'],
    'topics' => ['machine learning', 'quantum computing'],
    'numbers' => [
        ['value' => '1.2', 'unit' => 'billion', 'raw' => '1.2 billion'],
        ['value' => '42', 'unit' => 'percent', 'raw' => '42%']
    ],
    'hashtags' => ['AI', 'blockchain']
]
```

**Example:**

PHP:
```php
$entities = AI_LLM::extractEntities('Apple CEO Tim Cook announced $2 billion investment in AI.');
// persons: ['Tim Cook']
// orgs: ['Apple', 'AI']
// numbers: [{value: '2', unit: 'billion', ...}]
```

JavaScript:
```javascript
var entities = AI_LLM.extractEntities('Apple CEO Tim Cook announced $2 billion investment in AI.');
console.log(entities.persons);  // ['Tim Cook']
console.log(entities.orgs);     // ['Apple', 'AI']
```

### `buildSearchQueries($entities, [$contextHint])`

Build Pexels/Pixabay/archive search queries from extracted entities.

**Returns:** Array of query strings (most specific first)

**Example:**

PHP:
```php
$queries = AI_LLM::buildSearchQueries($entities, 'technology');
// ['Tim Cook technology', 'Tim Cook', 'Apple technology', 'Apple', '$2 billion statistics', ...]
```

### `lookupStreams($names, [$options])`

Look up Qbix stream titles matching entity names (no LLM call).

**Returns:** Promise<array> of {publisherId, streamName, title, icon}

**Example:**

PHP:
```php
AI_LLM::lookupStreams(['Tim Cook', 'Apple'], ['limit' => 3])
    ->then(function($results) {
        // $results = [{publisherId: 'com.apple', streamName: 'Profiles/apple', title: 'Apple', ...}]
    });
```

JavaScript:
```javascript
AI_LLM.lookupStreams(['Tim Cook', 'Apple'], {limit: 3})
    .then(function(results) {
        console.log(results);
    });
```

---

## High-Level Utilities

### `summarize($text, [$options])`

Extract title, keywords, summary, and speakers from text.

**Parameters:**

- `$text` (string): Text to summarize
- `$options` (array): Execution options (model, temperature, etc.)

**Returns:** Object with keys:
- `title` (string, max 200 chars)
- `keywords` (array of strings)
- `summary` (string, max 512 chars)
- `speakers` (comma-separated names or empty)

**Example:**

PHP:
```php
$llm = AI_LLM::create('anthropic');
$result = $llm->summarize('Alice and Bob discussed AI safety...');
// {
//   title: 'AI Safety Discussion',
//   keywords: ['AI', 'safety', 'alignment'],
//   summary: 'Alice and Bob explored risks and mitigation strategies...',
//   speakers: 'Alice, Bob'
// }
```

JavaScript:
```javascript
llm.summarize('Alice and Bob discussed AI safety...')
    .then(function(result) {
        console.log('Title:', result.title);
        console.log('Keywords:', result.keywords);
    });
```

### `keywords($keywords, $during, [$options, &$keywordsNative])`

Expand canonical keywords into related search terms.

**Parameters:**

- `$keywords` (array): 1–2 word canonical keywords
- `$during` (string): "insert" (broad expansion) or "query" (narrow, literal)
- `$options` (array): Execution options + `language` for native-language expansion
- `$keywordsNative` (array, by-ref): Filled with native-language keywords if language != "en" (PHP only)

**Returns:** Array of expanded keywords

**Example:**

PHP:
```php
$expanded = $llm->keywords(['AI', 'safety'], 'insert', ['language' => 'es']);
// English: ['AI', 'artificial intelligence', 'machine learning', 'safety', 'alignment', ...]
// Spanish: ['IA', 'inteligencia artificial', 'seguridad', ...]
```

JavaScript:
```javascript
llm.keywords(['AI', 'safety'], 'insert', {language: 'es'})
    .then(function(result) {
        console.log('Expanded:', result);
    });
```

---

## Web Search

### Declaring Web Search Support

**PHP:**
```php
public function supportsWebSearch() {
    return true;
}
```

**JavaScript:**
```javascript
AI_LLM.Openai.prototype.supportsWebSearch = function() {
    return true;
};
```

### Enabling Web Search

**Configuration:**

Set in options:

```php
$options['webSearch'] = true;  // default config
$options['webSearch'] = [
    'maxUses' => 5,
    'contextSize' => 'medium',  // 'small', 'medium', 'large'
    'allowedDomains' => ['wikipedia.org', 'arxiv.org'],
    'userLocation' => 'San Francisco'
];
```

### `searchAndRespond($instructions, $query, [$options])`

High-level helper: search web, return answer + citations.

**Returns:** String or {text, citations} if options['includeCitations'] = true

**Example:**

PHP:
```php
$llm = AI_LLM::route('search');  // webSearch forced on
$result = $llm->searchAndRespond(
    'You are a news analyst.',
    'What are the latest AI developments?',
    ['includeCitations' => true]
);
// {
//   text: 'Recent AI developments include...',
//   citations: [{url: '...', title: '...', snippet: '...'}]
// }
```

JavaScript:
```javascript
var llm = AI_LLM.route('search');
llm.searchAndRespond('You are a news analyst.', 'What are the latest AI developments?', {
    includeCitations: true
}).then(function(result) {
    console.log('Answer:', result.text);
    console.log('Sources:', result.citations);
});
```

---

## Configuration

### PHP: Q_Config

```php
Q_Config::set('AI', array(
    'llm' => array(
        'default' => 'anthropic-direct',
        'structuredOutputs' => true,  // enable native structured outputs
        'routes' => array(
            'smart' => 'anthropic-direct',
            'fast' => 'openai-mini',
            'vision' => 'anthropic-direct',
            'search' => 'anthropic-direct'
        ),
        'providers' => array(
            'anthropic-direct' => array(
                'class' => 'Anthropic',
                'config' => array(
                    'model' => 'claude-3-5-sonnet-20241022',
                    'temperature' => 0.7
                )
            ),
            'openai-mini' => array(
                'class' => 'Openai',
                'config' => array(
                    'model' => 'gpt-4o-mini',
                    'temperature' => 0.5
                )
            )
        )
    )
));
```

### JavaScript: Q.Config

```javascript
Q.Config.set(['AI', 'llm', 'default'], 'anthropic-direct');
Q.Config.set(['AI', 'llm', 'structuredOutputs'], true);
Q.Config.set(['AI', 'llm', 'routes'], {
    smart: 'anthropic-direct',
    fast: 'openai-mini'
});
Q.Config.set(['AI', 'llm', 'providers'], {
    'anthropic-direct': {
        class: 'Anthropic',
        config: {model: 'claude-3-5-sonnet-20241022', temperature: 0.7}
    }
});
```

---

## Examples

### Complete Observation Pipeline

PHP:
```php
$llm = AI_LLM::route('smart');

$inputs = [
    'text' => 'Tesla announced record Q4 earnings of $5.2 billion...',
    'images' => [file_get_contents('chart.png')]
];

$observations = [
    'financialMetrics' => [
        'promptClause' => 'Extract financial metrics (revenue, earnings, growth rate)',
        'fieldNames' => ['metric', 'value', 'unit', 'confidence'],
        'example' => ['metric' => 'earnings', 'value' => '5.2', 'unit' => 'billion', 'confidence' => 0.95]
    ]
];

$result = $llm->process($inputs, $observations);
// {
//   financialMetrics: [
//     {metric: 'earnings', value: '5.2', unit: 'billion', confidence: 0.95}
//   ]
// }
```

JavaScript:
```javascript
var llm = AI_LLM.route('smart');
var inputs = {
    text: 'Tesla announced record Q4 earnings of $5.2 billion...',
    images: [imageBinary]
};

llm.process(inputs, {
    financialMetrics: {
        promptClause: 'Extract financial metrics (revenue, earnings, growth rate)',
        fieldNames: ['metric', 'value', 'unit', 'confidence'],
        example: {metric: 'earnings', value: '5.2', unit: 'billion', confidence: 0.95}
    }
}).then(function(result) {
    console.log('Metrics:', result.financialMetrics);
});
```

### NER + Stream Lookup

PHP:
```php
$text = 'Steve Jobs founded Apple in 1976 with Wozniak.';
$entities = AI_LLM::extractEntities($text);

AI_LLM::lookupStreams($entities['persons'], ['limit' => 5])
    ->then(function($streams) {
        foreach ($streams as $s) {
            echo $s['title'] . "\n";
        }
    });
```

### Search + Respond

PHP:
```php
$llm = AI_LLM::route('search');
$llm->searchAndRespond(
    'You are a technology reporter.',
    'What are the latest AI model releases?',
    ['includeCitations' => true]
)->then(function($result) {
    echo $result['text'] . "\n";
    foreach ($result['citations'] as $cite) {
        echo "- " . $cite['title'] . " (" . $cite['url'] . ")\n";
    }
});
```

### Conditional Web Search

PHP:
```php
$llm = AI_LLM::route('smart');
$options = ['webSearch' => false];

if ($needsCurrent) {
    $options['webSearch'] = true;
}

$result = $llm->executeModel('Answer this question', $inputs, $options);
```

---

## Error Handling

**PHP:**
```php
try {
    $result = $llm->process($inputs, $observations);
} catch (Exception $e) {
    error_log("LLM error: " . $e->getMessage());
    return null;
}
```

**JavaScript:**
```javascript
llm.process(inputs, observations)
    .then(function(result) { /* ... */ })
    .catch(function(err) {
        console.error('LLM error:', err.message);
    });
```

---

## Performance Tuning

**Route Selection by Speed:**

| Route | Speed | Quality | Use Case |
|-------|-------|---------|----------|
| `fast` | ⚡⚡⚡ | ⭐⭐ | Real-time feedback, entity detection |
| `smart` | ⚡⚡ | ⭐⭐⭐⭐ | Proposals, analysis, synthesis |
| `vision` | ⚡ | ⭐⭐⭐⭐⭐ | Image analysis, complex reasoning |

**Temperature by Task:**

| Task | Temperature | Example |
|------|-------------|---------|
| Summarization | 0.0 | Summaries, entity extraction |
| Q&A | 0.3–0.5 | Factual answers, web search |
| Analysis | 0.7 | Creative proposals, alternatives |
| Generation | 1.0–1.5 | Brainstorming, creative writing |

**Token Budget:**

```php
// Tight budget (mobile, real-time)
$options['max_tokens'] = 300;

// Balanced
$options['max_tokens'] = 1000;

// Generous (complex tasks)
$options['max_tokens'] = 4000;
```

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 2.0 | 2025-01-15 | Route-based deployment, web search, comprehensive YUIDoc for PHP & JS |
| 1.0 | Earlier | Basic execution, observations pipeline |

---

## See Also

- [AI_Image Documentation](./AI_IMAGE_UNIFIED_DOCUMENTATION.md)
- [OpenAI API](https://platform.openai.com/docs)
- [Anthropic API](https://docs.anthropic.com)
- [Google Gemini API](https://ai.google.dev)
- [AWS Bedrock](https://docs.aws.amazon.com/bedrock/)