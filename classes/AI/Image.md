# AI_Image API Documentation (PHP & JavaScript)

Complete reference for image generation and processing across providers.

---

## Table of Contents

1. [Overview](#overview)
2. [Core Interface](#core-interface)
3. [Factory Pattern](#factory-pattern)
4. [Prompt Utilities](#prompt-utilities)
5. [Adapters](#adapters)
   - [OpenAI (DALL-E)](#openai-dalle)
   - [AWS Bedrock (Stability AI)](#aws-bedrock-stability-ai)
   - [Google Vertex AI](#google-vertex-ai)
6. [Common Patterns](#common-patterns)
7. [Error Handling](#error-handling)
8. [Configuration](#configuration)

---

## Overview

The AI_Image system provides a unified, language-agnostic interface for image generation, editing, and background removal across multiple AI providers.

**Supported Providers:**
- **OpenAI** (DALL-E 2, DALL-E 3, gpt-image-1.5)
- **AWS Bedrock** (Stability AI: SDXL, SD Remix)
- **Google Vertex AI** (Gemini Image via proxy)

**Available across:**
- PHP: `classes/AI/Image.php` and `classes/AI/Image/<Adapter>.php`
- JavaScript: `modules/AI/Image.js` and `modules/AI/Image/<Adapter>.js`

---

## Core Interface

All adapters implement a common contract:

### PHP
```php
interface AI_Image_Interface {
    public function generate($prompt, $options = array());
    public function removeBackground($image, $options = array());
}
```

### JavaScript
```javascript
AI_Image.prototype.generate = function (prompt, options) { /* ... */ };
AI_Image.prototype.removeBackground = function (image, options) { /* ... */ };
```

---

## Factory Pattern

### PHP: `AI_Image::create()`

```php
$adapter = AI_Image::create($name, $options);
```

**Parameters:**
- `$name` (string|object): Adapter name ("openai", "aws", "google") or full class name, or existing instance
- `$options` (array): Optional constructor parameters

**Returns:** Adapter instance or null

**Examples:**
```php
$ai = AI_Image::create('openai');
$ai = AI_Image::create('google');
$ai = AI_Image::create('AI_Image_Aws');

// With error handling
if (!$ai = AI_Image::create('openai')) {
    throw new Exception('OpenAI adapter not found');
}
```

### JavaScript: `AI_Image.create()`

```javascript
var adapter = AI_Image.create(name, options);
```

**Parameters:** Same as PHP

**Returns:** Adapter instance or null

**Examples:**
```javascript
var ai = AI_Image.create('openai');
var ai = AI_Image.create('google');

if (!ai) {
    console.error('Adapter not found');
    return;
}
```

---

## Prompt Utilities

### `promptFace($default = null)` — Static Method

Generates a smart prompt for face image generation and background removal.

**Behavior:**
1. **Complete visible face** → center and remove background, preserve face exactly
2. **Partial/obscured face** → generate full face close to original, remove background
3. **Non-face input** (NSFW, objects) → generate cute animal face instead

**Parameters:**
- `$default` (string): Animal name for non-face fallback
  - If null or invalid, randomly selects from 100 curated animals
  - Examples: "cat", "dog", "fox", "polar bear", "penguin", "unicorn"

**Returns:** String prompt

**100 Curated Animals:**
Domestic (cat, dog, horse, cow, etc.), Wild Predators (lion, tiger, wolf, fox, bear, etc.), Wild Herbivores (elephant, giraffe, zebra, etc.), Primates, Birds (eagle, owl, penguin, parrot, etc.), Reptiles (snake, lizard, crocodile, turtle, etc.), Aquatic (whale, dolphin, shark, etc.), Insects (butterfly, bee, ant, etc.), Mythical (dragon, unicorn, phoenix, griffin).

### PHP Example

```php
// Random animal fallback
$prompt = AI_Image::promptFace();

// Specific animal (consistent branding)
$prompt = AI_Image::promptFace('cat');

// Use with adapter
$ai = AI_Image::create('google');
$result = $ai->generate(AI_Image::promptFace('dog'), [
    'images' => [file_get_contents('user_photo.jpg')],
    'background' => 'transparent',
    'format' => 'png'
]);
if (empty($result['error'])) {
    file_put_contents('user_face.png', $result['data']);
}
```

### JavaScript Example

```javascript
// Random animal fallback
var prompt = AI_Image.promptFace();

// Specific animal
var prompt = AI_Image.promptFace('fox');

// Use with adapter
var ai = AI_Image.create('google');
ai.generate(AI_Image.promptFace('cat'), {
    images: [fs.readFileSync('user_photo.jpg')],
    background: 'transparent',
    format: 'png'
}).then(function(res) {
    if (res.data) {
        fs.writeFileSync('user_face.png', res.data);
    }
});
```

### `estimateFaces($imagePath, $callback)` — Static Method

Detects face bounding boxes in an image using face-api.js or TensorFlow.

**Parameters:**
- `$imagePath` (string): File path to image
- `$callback` (function): Callback(err, faces) where faces is array of {topLeft: [x, y], bottomRight: [x, y]}

**Returns:** Nothing (async via callback)

**PHP Example:**
```php
AI_Image::estimateFaces('/path/to/photo.jpg', function($faces) {
    if (!empty($faces)) {
        echo "Found " . count($faces) . " face(s)\n";
        foreach ($faces as $f) {
            echo "  topLeft: " . json_encode($f['topLeft']) . "\n";
        }
    }
});
```

**JavaScript Example:**
```javascript
AI_Image.estimateFaces('/path/to/photo.jpg', function(faces, err) {
    if (faces.length) {
        console.log('Found ' + faces.length + ' face(s)');
        faces.forEach(function(f) {
            console.log('  topLeft:', f.topLeft, 'bottomRight:', f.bottomRight);
        });
    }
});
```

---

## Adapters

### OpenAI (DALL-E)

**Configuration:**

PHP:
```php
Q_Config::set('AI', array(
    'openAI' => array('key' => 'sk-...'),
    'images' => array('openai' => array('model' => 'dall-e-3'))
));
```

JavaScript:
```javascript
Q.Config.set(['AI', 'openAI', 'key'], 'sk-...');
Q.Config.set(['AI', 'images', 'openai', 'model'], 'dall-e-3');
```

**Method: `generate($prompt, $options)`**

Generates images from text or with image reference guidance.

**Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `model` | string | 'gpt-image-1.5' | Model ID: "dall-e-3", "dall-e-2", "gpt-image-1.5" |
| `format` | string | 'png' | Output: "png", "jpg", "jpeg", "webp" |
| `size` | string | '1024x1024' | Dimensions as "WIDTHxHEIGHT" (1024, 1536, etc.) |
| `width` | integer | 1024 | Width in pixels (overrides size) |
| `height` | integer | 1024 | Height in pixels (overrides size) |
| `quality` | string | 'auto' | "standard" (→ auto) or "hd" (→ high). DALL-E 3 only |
| `images` | array | — | Reference images (binary) for edit mode |
| `timeout` | integer | 60 | Request timeout in seconds |

**Returns:**
- Success: `['data' => binary, 'format' => 'png']` (PHP) or `{data: Buffer, format: 'png'}` (JS)
- Error: `['error' => mixed]` or `{error: mixed}`

**PHP Examples:**
```php
$ai = AI_Image::create('openai');

// Text-to-image
$result = $ai->generate('Mountain landscape at sunset', [
    'model' => 'dall-e-3',
    'size' => '1024x1024',
    'quality' => 'hd'
]);

// Image editing with reference
$baseImage = file_get_contents('original.jpg');
$result = $ai->generate('Change sky to purple', [
    'images' => [$baseImage],
    'model' => 'dall-e-2'
]);

// Face generation
$result = $ai->generate(AI_Image::promptFace('cat'), [
    'images' => [file_get_contents('user.jpg')],
    'format' => 'png'
]);
```

**JavaScript Examples:**
```javascript
var ai = AI_Image.create('openai');

ai.generate('Mountain landscape', {
    model: 'dall-e-3',
    size: '1024x1024',
    quality: 'hd'
}).then(function(res) {
    if (res.data) {
        fs.writeFileSync('output.png', res.data);
    }
});

// With reference image
ai.generate('Change the sky', {
    images: [fs.readFileSync('original.jpg')],
    format: 'png'
}).then(function(res) { /* ... */ });
```

**Method: `removeBackground($image, $options)`**

Removes background using image edits API.

**PHP:**
```php
$image = file_get_contents('portrait.jpg');
$result = $ai->removeBackground($image, ['format' => 'png']);
if (empty($result['error'])) {
    file_put_contents('transparent.png', $result['data']);
}
```

**JavaScript:**
```javascript
ai.removeBackground(fs.readFileSync('portrait.jpg'), {format: 'png'})
    .then(function(res) {
        if (res.data) {
            fs.writeFileSync('transparent.png', res.data);
        }
    });
```

---

### AWS Bedrock (Stability AI)

**Configuration:**

PHP:
```php
Q_Config::set('AI', array(
    'aws' => array(
        'key' => 'AKIA...',
        'secret' => '...',
        'region' => 'us-east-1'
    ),
    'images' => array('aws' => array('model' => 'stability.stable-diffusion-xl-v0'))
));
```

JavaScript:
```javascript
Q.Config.set(['AI', 'aws', 'key'], 'AKIA...');
Q.Config.set(['AI', 'aws', 'secret'], '...');
Q.Config.set(['AI', 'aws', 'region'], 'us-east-1');
```

**Method: `generate($prompt, $options)`**

Generates images using AWS Bedrock Stability AI models (SDXL, SD Remix).

**Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `model` | string | 'stability.stable-diffusion-xl-v0' | Bedrock model ID |
| `size` | string | '1024x1024' | Dimensions as "WIDTHxHEIGHT" |
| `width` | integer | — | Width in pixels (overrides size) |
| `height` | integer | — | Height in pixels (overrides size) |
| `steps` | integer | 50 | Diffusion steps (20–150, higher = more detail, slower) |
| `seed` | integer | random | Seed for reproducibility |
| `images` | array | — | Reference images for image-to-image mode |

**Returns:**
- Success: `['data' => binary, 'format' => 'png']` or `['b64_json' => base64]`
- Error: `['error' => mixed]`

**PHP Examples:**
```php
$ai = AI_Image::create('aws');

$result = $ai->generate('Cyberpunk city at night', [
    'model' => 'stability.stable-diffusion-xl-v0',
    'size' => '1024x1024',
    'steps' => 80
]);

if (!empty($result['data'])) {
    file_put_contents('output.png', $result['data']);
} elseif (!empty($result['b64_json'])) {
    file_put_contents('output.png', base64_decode($result['b64_json']));
}

// Image-to-image: style transfer
$baseImage = file_get_contents('original.jpg');
$result = $ai->generate('Oil painting style', [
    'images' => [$baseImage],
    'steps' => 60
]);
```

**JavaScript Examples:**
```javascript
var ai = AI_Image.create('aws');

ai.generate('Cyberpunk city', {
    model: 'stability.stable-diffusion-xl-v0',
    size: '1024x1024',
    steps: 80
}).then(function(res) {
    if (res.data) {
        fs.writeFileSync('output.png', res.data);
    }
});
```

**Method: `removeBackground($image, $options)`**

Removes background using SD Remix inpainting model.

**PHP:**
```php
$image = file_get_contents('photo.jpg');
$result = $ai->removeBackground($image, [
    'format' => 'png',
    'steps' => 50
]);
if (empty($result['error'])) {
    file_put_contents('transparent.png', $result['data']);
}
```

**JavaScript:**
```javascript
ai.removeBackground(fs.readFileSync('photo.jpg'), {
    format: 'png',
    steps: 50
}).then(function(res) {
    if (res.data) {
        fs.writeFileSync('transparent.png', res.data);
    }
});
```

---

### Google Vertex AI

**Configuration:**

Requires Node.js proxy server running (see proxy documentation).

PHP:
```php
Q_Config::set('AI', array(
    'google' => array(
        'url' => 'http://localhost:8080',  // Proxy server URL
        'clientId' => 'client-id-string',
        'secret' => 'hmac-secret-key'
    )
));
```

JavaScript:
```javascript
Q.Config.set(['AI', 'google', 'url'], 'http://localhost:8080');
Q.Config.set(['AI', 'google', 'clientId'], 'client-id-string');
Q.Config.set(['AI', 'google', 'secret'], 'hmac-secret-key');
```

**Method: `generate($prompt, $options)`**

Generates images via Vertex AI with advanced background handling.

**Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `format` | string | 'png' | "png", "jpg", "webp", "gif" |
| `width` | integer | 1024 | Width in pixels (max 4096) |
| `height` | integer | 1024 | Height in pixels (max 4096) |
| `size` | string | — | Size as "WIDTHxHEIGHT" (overrides width/height) |
| `background` | string | 'none' | "none" (keep), "transparent" (remove), "gradient" (add) |
| `feather` | integer | 20 | Alpha feathering for transparency edges (0–100 pixels) |
| `bgColor` | string | '#f2f2f2' | Background hint color for isolation (hex format) |
| `images` | array | — | Reference images for guided generation (up to 5) |
| `timeout` | integer | 60 | Request timeout in seconds |

**Background Modes:**

| Mode | Description | Output |
|------|-------------|--------|
| `'none'` | Keep original background | Any format (RGB) |
| `'transparent'` | Remove background | PNG/WebP (RGBA) |
| `'gradient'` | Composite onto teal-to-blue gradient | PNG (RGB) |

**Returns:**
- Success: `['data' => binary, 'format' => 'png']` or `{data: Buffer, format: 'png'}`
- Error: `['error' => mixed]` or `{error: mixed}`

**PHP Examples:**
```php
$ai = AI_Image::create('google');

// Text-to-image
$result = $ai->generate('Japanese garden with koi pond', [
    'format' => 'png',
    'width' => 1024,
    'height' => 1024
]);

// With transparent background
$result = $ai->generate('Professional headshot', [
    'background' => 'transparent',
    'feather' => 15,
    'bgColor' => '#ffffff',
    'format' => 'png'
]);

// Image-guided generation (reference)
$styleRef = file_get_contents('style.jpg');
$result = $ai->generate('Paint in style of photo 1 with sunset', [
    'images' => [$styleRef],
    'background' => 'transparent',
    'width' => 1536,
    'height' => 1024
]);

// Composite over gradient
$result = $ai->generate('Product lifestyle', [
    'background' => 'gradient',
    'format' => 'png',
    'width' => 1200,
    'height' => 630
]);
```

**JavaScript Examples:**
```javascript
var ai = AI_Image.create('google');

ai.generate('Japanese garden', {
    format: 'png',
    width: 1024,
    height: 1024
}).then(function(res) {
    if (res.data) {
        fs.writeFileSync('garden.png', res.data);
    }
});

// With transparent background
ai.generate('Professional headshot', {
    background: 'transparent',
    feather: 15,
    bgColor: '#ffffff'
}).then(function(res) { /* ... */ });

// Image-guided
ai.generate(AI_Image.promptFace('dog'), {
    images: [fs.readFileSync('user.jpg')],
    background: 'transparent'
}).then(function(res) { /* ... */ });
```

**Method: `removeBackground($image, $options)`**

Removes background with fine-tuned edge handling via proxy.

**PHP:**
```php
$image = file_get_contents('portrait.jpg');
$result = $ai->removeBackground($image, [
    'format' => 'png',
    'feather' => 25,
    'bgColor' => '#ffffff'
]);

if (empty($result['error'])) {
    file_put_contents('portrait_transparent.png', $result['data']);
}
```

**JavaScript:**
```javascript
ai.removeBackground(fs.readFileSync('portrait.jpg'), {
    format: 'png',
    feather: 25,
    bgColor: '#ffffff'
}).then(function(res) {
    if (res.data) {
        fs.writeFileSync('portrait_transparent.png', res.data);
    }
});
```

---

## Common Patterns

### Factory with Error Handling

**PHP:**
```php
$adapter = AI_Image::create('openai');
if (!$adapter) {
    throw new Exception('OpenAI adapter not available');
}

$result = $adapter->generate('prompt', [/* options */]);
if (!empty($result['error'])) {
    error_log("Generation failed: {$result['error']}");
    return null;
}

return $result['data'];
```

**JavaScript:**
```javascript
var adapter = AI_Image.create('openai');
if (!adapter) {
    throw new Error('OpenAI adapter not available');
}

adapter.generate('prompt', {/* options */})
    .then(function(result) {
        if (result.error) {
            console.error('Generation failed:', result.error);
            return null;
        }
        return result.data;
    });
```

### Batch Processing with Fallback

**PHP:**
```php
$prompts = ['landscape', 'portrait', 'abstract'];
$adapter = AI_Image::create('google');

foreach ($prompts as $prompt) {
    $result = $adapter->generate($prompt, [
        'background' => 'transparent',
        'format' => 'png',
        'timeout' => 120
    ]);
    
    if (empty($result['error'])) {
        $filename = 'output_' . md5($prompt) . '.png';
        file_put_contents($filename, $result['data']);
        echo "✓ $filename\n";
    } else {
        echo "✗ Error: {$result['error']}\n";
    }
}
```

**JavaScript:**
```javascript
var prompts = ['landscape', 'portrait', 'abstract'];
var adapter = AI_Image.create('google');

prompts.forEach(function(prompt) {
    adapter.generate(prompt, {
        background: 'transparent',
        format: 'png',
        timeout: 120
    }).then(function(result) {
        if (result.error) {
            console.error('✗ Error:', result.error);
            return;
        }
        var filename = 'output_' + require('crypto')
            .createHash('md5')
            .update(prompt)
            .digest('hex') + '.png';
        fs.writeFileSync(filename, result.data);
        console.log('✓', filename);
    });
});
```

### Face Generation with Smart Prompt

**PHP:**
```php
$userPhoto = file_get_contents($_FILES['photo']['tmp_name']);
$ai = AI_Image::create('google');

$result = $ai->generate(AI_Image::promptFace('cat'), [
    'images' => [$userPhoto],
    'background' => 'transparent',
    'feather' => 20,
    'format' => 'png'
]);

if (empty($result['error'])) {
    header('Content-Type: image/png');
    echo $result['data'];
} else {
    http_response_code(400);
    echo json_encode(['error' => $result['error']]);
}
```

**JavaScript:**
```javascript
var multer = require('multer');
var upload = multer();

app.post('/generate-face', upload.single('photo'), function(req, res) {
    var ai = AI_Image.create('google');
    
    ai.generate(AI_Image.promptFace('dog'), {
        images: [req.file.buffer],
        background: 'transparent',
        feather: 20,
        format: 'png'
    }).then(function(result) {
        if (result.error) {
            return res.status(400).json({error: result.error});
        }
        res.set('Content-Type', 'image/png');
        res.send(result.data);
    });
});
```

---

## Error Handling

All methods return error arrays on failure. Handle gracefully:

**PHP:**
```php
$result = $adapter->generate('prompt', $options);

if (!empty($result['error'])) {
    // Handle error
    $error = $result['error'];
    if (is_array($error)) {
        // Decoded JSON error from provider
        error_log(json_encode($error));
    } else {
        // String error message
        error_log((string)$error);
    }
    return null;
}

// Success
$imageData = $result['data'];
```

**JavaScript:**
```javascript
adapter.generate('prompt', options)
    .then(function(result) {
        if (result.error) {
            console.error('Error:', result.error);
            return null;
        }
        
        var imageData = result.data;
        return imageData;
    })
    .catch(function(err) {
        console.error('Promise rejection:', err);
    });
```

---

## Configuration

### PHP: Q_Config

Set in application bootstrap or environment:

```php
// OpenAI
Q_Config::set('AI', array(
    'openAI' => array(
        'key' => 'sk-...'
    ),
    'images' => array(
        'openai' => array(
            'model' => 'dall-e-3'
        )
    )
));

// AWS
Q_Config::set('AI', array(
    'aws' => array(
        'key' => 'AKIA...',
        'secret' => '...',
        'region' => 'us-east-1'
    ),
    'images' => array(
        'aws' => array(
            'model' => 'stability.stable-diffusion-xl-v0'
        )
    )
));

// Google
Q_Config::set('AI', array(
    'google' => array(
        'url' => 'http://localhost:8080',
        'clientId' => 'client-id',
        'secret' => 'hmac-secret'
    )
));
```

### JavaScript: Q.Config

```javascript
// OpenAI
Q.Config.set(['AI', 'openAI', 'key'], 'sk-...');
Q.Config.set(['AI', 'images', 'openai', 'model'], 'dall-e-3');

// AWS
Q.Config.set(['AI', 'aws', 'key'], 'AKIA...');
Q.Config.set(['AI', 'aws', 'secret'], '...');
Q.Config.set(['AI', 'aws', 'region'], 'us-east-1');

// Google
Q.Config.set(['AI', 'google', 'url'], 'http://localhost:8080');
Q.Config.set(['AI', 'google', 'clientId'], 'client-id');
Q.Config.set(['AI', 'google', 'secret'], 'hmac-secret');
```

---

## Performance Tuning

**Model Selection:**
- **OpenAI DALL-E 3**: Highest quality, slowest (30–60s)
- **DALL-E 2**: Faster, good quality (10–30s)
- **AWS SDXL**: Fast high quality (10–20s)
- **Google Gemini**: Fast, variable quality (5–15s)

**Timeout Recommendations:**
- Text-to-image: 60–120 seconds
- Image editing: 60–90 seconds
- Background removal: 30–60 seconds

**Batch Operations:**
- Use async/Promise patterns for non-blocking processing
- Implement retry logic for transient failures (timeouts, rate limits)

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 2.0 | 2025-01-15 | Added reference image support, promptFace(), comprehensive YUIDoc for PHP & JS |
| 1.0 | Earlier | Initial release (basic generation/removeBackground) |

---

## Support & Troubleshooting

**Issue: API key missing**
- Ensure Q_Config is properly set before adapter creation
- Check config key paths (e.g., `['AI', 'openAI', 'key']`)

**Issue: Adapter not found**
- Verify adapter file is loaded/required (auto-loaded via factory in most setups)
- Check adapter class name normalization: "open-ai" → "AI_Image_OpenAi"

**Issue: Proxy error (Google)**
- Ensure Node.js proxy server is running and accessible
- Verify URL, clientId, secret in config
- Check HMAC signature generation

**Issue: NSFW/non-face input**
- Use `promptFace()` for safe fallback to cute animal instead of error/crash
- Customize animal via `promptFace('cat')` parameter

---

## See Also

- [Google Vertex Proxy Documentation](./PROXY.md)
- [OpenAI Images API](https://platform.openai.com/docs/guides/images)
- [AWS Bedrock Documentation](https://docs.aws.amazon.com/bedrock/)
- [Google Vertex AI Documentation](https://cloud.google.com/vertex-ai/docs)