# Adapter Authoring Guide

This guide explains how to add new provider adapters to the AI plugin. Adapters exist in two categories — LLM (batch) and Voice (realtime). Both follow the same architectural pattern: PHP and JS twins, config-driven routing, interface-defined contracts.

## Architecture overview

The AI plugin has a two-tier provider model. Every category (LLM, Image, Transcription, Voice) has:

1. A **router** (`AI_LLM::route()`, `AI_Voice::route()`) that resolves a deployment-configured route name to a provider class.
2. A **base interface** every adapter implements (`AI_LLM_Interface`, `AI_Voice_Interface`).
3. An optional **advanced interface** for providers with extra capabilities (`AI_LLM_AdvancedInterface` for prefix caching).
4. Per-provider **adapter classes** in `classes/AI/<Category>/<Provider>.php` and `classes/AI/<Category>/<Provider>.js`.

Consumers call the router; the router returns an adapter instance; the consumer calls methods on the adapter without caring which provider it is.

## File layout for a new LLM adapter

For a hypothetical "Acme" provider:

```
classes/AI/LLM/Acme.php       — PHP adapter (required for app-side code)
classes/AI/LLM/Acme.js        — JS adapter (required for sandbox/Node code)
```

Both files are loaded by name when `AI_LLM::create('Acme')` or `AI_LLM.create('Acme')` is called.

## PHP adapter template

```php
<?php

/**
 * AI_LLM_Acme — Acme provider adapter.
 *
 * Implements AI_LLM_Interface (required) and optionally
 * AI_LLM_AdvancedInterface (for prefix caching).
 *
 * Config:
 *   AI/acme/apiKey  — required
 *   AI/acme/baseUrl — default https://api.acme.com
 *   AI/llm/models/acme — default model name
 */
class AI_LLM_Acme extends AI_LLM implements AI_LLM_Interface
{
    protected $apiKey;
    protected $baseUrl;
    protected $defaultModel;

    function __construct($options = array())
    {
        $this->apiKey = isset($options['apiKey'])
            ? $options['apiKey']
            : Q_Config::expect('AI', 'acme', 'apiKey');
        $this->baseUrl = rtrim(isset($options['baseUrl'])
            ? $options['baseUrl']
            : Q_Config::get(array('AI', 'acme', 'baseUrl'), 'https://api.acme.com'), '/');
        $this->defaultModel = isset($options['model'])
            ? $options['model']
            : Q_Config::get(array('AI', 'llm', 'models', 'acme'), 'acme-default');
    }

    public function executeModel($instructions, array $inputs, array $options = array(), &$raw = null)
    {
        $model = isset($options['model']) ? $options['model'] : $this->defaultModel;
        $maxTokens   = Q::ifset($options, 'max_tokens',
            Q_Config::get(array('AI', 'llm', 'maxTokens'), 4096));
        $temperature = Q::ifset($options, 'temperature', 0.5);
        $timeout     = Q::ifset($options, 'timeout', 120);

        // 1. Build messages from options['messages'] or legacy options['user']
        $messages = $this->_buildMessages($options, $inputs);

        // 2. Build provider-specific request body
        $body = array(
            'model'       => $model,
            'messages'    => $messages,
            'max_tokens'  => $maxTokens,
            'temperature' => $temperature
        );
        if ($instructions) {
            $body['system'] = $instructions;
        }
        // Pass through tools, response_format, json_schema if supported

        // 3. Make the HTTP call
        $response = Q_Utils::post(
            $this->baseUrl . '/v1/chat/completions',
            $body,
            null,
            array(
                'CURLOPT_HTTPHEADER' => array(
                    'Content-Type: application/json',
                    'Authorization: Bearer ' . $this->apiKey
                ),
                'CURLOPT_TIMEOUT' => $timeout
            )
        );

        if (!$response) {
            throw new Exception('AI_LLM_Acme: empty response');
        }
        $decoded = is_array($response) ? $response : json_decode($response, true);
        if (!is_array($decoded)) {
            throw new Exception('AI_LLM_Acme: non-JSON response');
        }
        if (isset($decoded['error'])) {
            throw new Exception('AI_LLM_Acme error: ' . json_encode($decoded['error']));
        }

        // 4. Extract text from provider-specific response shape
        $raw = $decoded;
        return isset($decoded['choices'][0]['message']['content'])
            ? $decoded['choices'][0]['message']['content']
            : '';
    }

    protected function _buildMessages(array $options, array $inputs)
    {
        if (!empty($options['messages']) && is_array($options['messages'])) {
            return $options['messages'];
        }
        $messages = array();
        if (!empty($options['user'])) {
            $messages[] = array('role' => 'user', 'content' => (string)$options['user']);
        }
        // Add multimodal handling here if the provider supports it
        return $messages;
    }
}
```

## JS adapter template

```javascript
"use strict";
/**
 * AI.LLM.Acme — Acme adapter (JS).
 *
 * Same contract as PHP. Used from Safebox capabilities.
 */
var Q = require('Q');
var https = require('https');

function Acme(options) {
    options = options || {};
    this.apiKey = options.apiKey || Q.Config.get(['AI', 'acme', 'apiKey']);
    if (!this.apiKey) throw new Error('AI.LLM.Acme: apiKey required');
    this.baseUrl = (options.baseUrl
        || Q.Config.get(['AI', 'acme', 'baseUrl'], 'https://api.acme.com')).replace(/\/$/, '');
    this.defaultModel = options.model
        || Q.Config.get(['AI', 'llm', 'models', 'acme'], 'acme-default');
}

Acme.prototype.executeModel = function (instructions, inputs, options) {
    var self = this;
    options = options || {};
    inputs  = inputs  || {};
    var model       = options.model || this.defaultModel;
    var maxTokens   = options.max_tokens || options.maxTokens
        || Q.Config.get(['AI', 'llm', 'maxTokens'], 4096);
    var temperature = options.temperature != null ? options.temperature : 0.5;
    var timeout     = (options.timeout || 120) * 1000;

    var messages = this._buildMessages(options, inputs);
    var body = {
        model:       model,
        messages:    messages,
        max_tokens:  maxTokens,
        temperature: temperature
    };
    if (instructions) body.system = instructions;

    return new Promise(function (resolve, reject) {
        var data = JSON.stringify(body);
        var u = new URL(self.baseUrl + '/v1/chat/completions');
        var req = https.request({
            method: 'POST',
            hostname: u.hostname, port: u.port || 443, path: u.pathname,
            headers: {
                'Content-Type':   'application/json',
                'Content-Length': Buffer.byteLength(data),
                'Authorization':  'Bearer ' + self.apiKey
            },
            timeout: timeout
        }, function (res) {
            var chunks = [];
            res.on('data', function (c) { chunks.push(c); });
            res.on('end', function () {
                var raw = Buffer.concat(chunks).toString('utf8');
                try {
                    var parsed = JSON.parse(raw);
                    if (parsed.error) return reject(new Error('AI.LLM.Acme: '
                        + (parsed.error.message || JSON.stringify(parsed.error))));
                    var text = parsed.choices && parsed.choices[0]
                        && parsed.choices[0].message
                        && parsed.choices[0].message.content || '';
                    resolve({ text: text, raw: parsed, usage: parsed.usage || null });
                } catch (e) {
                    reject(new Error('AI.LLM.Acme: parse error: ' + e.message));
                }
            });
        });
        req.on('error', reject);
        req.on('timeout', function () { req.destroy(); reject(new Error('timeout')); });
        req.write(data);
        req.end();
    });
};

Acme.prototype._buildMessages = function (options, inputs) {
    if (options.messages && Array.isArray(options.messages)) return options.messages;
    var messages = [];
    if (options.user) messages.push({ role: 'user', content: String(options.user) });
    return messages;
};

module.exports = Acme;
```

## Implementing the advanced interface (optional)

If your provider supports prefix caching, prewarm, or explicit cache eviction:

```php
class AI_LLM_Acme extends AI_LLM implements AI_LLM_Interface, AI_LLM_AdvancedInterface
{
    public function executeWithCachedPrefix($cacheKey, $systemPrefix, array $inputs, array $options = array())
    {
        // Provider-specific prefix caching mechanism. Return same result shape as executeModel.
    }

    public function supportsPrefixCache() { return true; }

    public function prewarmPrefix($cacheKey, $systemPrefix, array $options = array())
    {
        // If your provider has an explicit prewarm API, call it.
        // Otherwise throw AI_LLM_Exception_NotSupported.
        throw new AI_LLM_Exception_NotSupported('AI_LLM_Acme: prewarmPrefix not supported.');
    }

    public function listCachedPrefixes()
    {
        // If your provider exposes cache introspection, return a map.
        throw new AI_LLM_Exception_NotSupported('AI_LLM_Acme: listCachedPrefixes not supported.');
    }

    public function dropCachedPrefix($cacheKey)
    {
        // If your provider has explicit eviction, call it.
        throw new AI_LLM_Exception_NotSupported('AI_LLM_Acme: dropCachedPrefix not supported.');
    }
}
```

JS-side equivalent:

```javascript
Acme.prototype.executeWithCachedPrefix = function (cacheKey, systemPrefix, inputs, options) { ... };
Acme.prototype.supportsPrefixCache     = function () { return true; };
Acme.prototype.prewarmPrefix           = function () { return Promise.reject(_notSupported(...)); };
Acme.prototype.listCachedPrefixes      = function () { return Promise.reject(_notSupported(...)); };
Acme.prototype.dropCachedPrefix        = function () { return Promise.reject(_notSupported(...)); };
```

## Wiring into deployment config

Once your `Acme.php` and `Acme.js` files exist, add to your environment's config under `AI/llm/providers`:

```json
"acme-direct": {
    "class": "Acme",
    "config": { "model": "acme-fast" }
}
```

Then map a route:

```json
"AI/llm/routes": {
    "fast": "acme-direct"
}
```

Consumers calling `AI_LLM::route('fast')` now receive an `AI_LLM_Acme` instance. No consumer code change needed.

## Voice adapter pattern

Voice adapters follow the same shape but implement `AI_Voice_Interface` instead. The two key methods are:

- `createSession($params)` — server-side: issues an ephemeral token for the given config, returns `{ token, wsUrl, expiresAt }` so the browser/iframe can connect directly. Never returns API keys.
- `getClientConfig()` — returns the JS adapter class name + protocol info the client will need to drive the session.

See `classes/AI/Voice.php` and the existing `AI/Voice/Openai.php` for a working example.

## Testing your adapter

Realistically, the only test that matters is running it against the real provider:

```bash
php -r "
require 'AI/classes/AI/LLM.php';
require 'AI/classes/AI/LLM/AdvancedInterface.php';
require 'AI/classes/AI/LLM/Acme.php';
\$llm = new AI_LLM_Acme(array('apiKey' => 'YOUR_KEY'));
echo \$llm->executeModel('You are helpful.', array(), array(
    'user' => 'Hello',
    'max_tokens' => 50
));
"
```

```javascript
const AI_LLM = require('AI/classes/AI/LLM');
const Acme   = require('AI/classes/AI/LLM/Acme');
const llm = new Acme({ apiKey: process.env.ACME_KEY });
llm.executeModel('You are helpful.', {}, { user: 'Hello', max_tokens: 50 })
   .then(r => console.log(r.text))
   .catch(console.error);
```

Things to check in your first real call:

- Request body matches what the provider expects (read their docs CAREFULLY)
- Authentication header is right
- Response shape parses correctly
- Errors surface with provider's error message intact (don't swallow them)
- Timeout works (provider hanging shouldn't hang your app forever)

## Common pitfalls

- **System prompt placement.** Providers vary: OpenAI = `instructions` field, Anthropic = top-level `system`, Gemini = `systemInstruction.parts`, others = first message with `role='system'`. The base interface receives a single `$instructions` string; your adapter places it correctly for its provider.

- **Tool calling shape.** Tool definitions and tool-call responses vary. If your provider supports tools, pass `options.tools` through to the provider's format and translate tool-call responses back into a consistent shape on output.

- **Multimodal inputs.** `$inputs['images']` is an array of binary strings (PHP) or Buffer/string (JS). Each provider has a different format: OpenAI's vision uses `{type: 'image_url', image_url: {url: data:...}}`, Anthropic uses `{type: 'image', source: {type: 'base64', media_type, data}}`, Gemini uses `{inline_data: {mime_type, data}}`. Your adapter does the translation.

- **JSON schema enforcement.** Some providers have native JSON-schema mode; others use prompting + post-validation. If your provider has native, use it (more reliable). Otherwise add the schema to the system prompt with "respond ONLY with valid JSON conforming to this schema:" prefix.

- **Streaming.** None of the current LLM adapters implement streaming. If yours does, return a stream-of-tokens callback rather than a final string, and document the callback shape in your docblock.

- **Errors.** Throw an `Exception` (PHP) or reject with `Error` (JS) — don't return error strings. Higher layers (workflow runners, retry logic) need to differentiate success from failure.

## Submitting

Once your adapter is working against real endpoints, send a pull request with:

1. `classes/AI/LLM/YourProvider.php`
2. `classes/AI/LLM/YourProvider.js`
3. A README section showing minimum config for your provider
4. An example route addition for the sample config

Don't ship without testing against a real endpoint — the failure modes of HTTP/auth/wire-format mismatches are too varied to catch by code review alone.
