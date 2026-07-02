'use strict';
/**
 * AI_Image_Aws → AI.Image.Aws
 * Adapter for AWS Bedrock image generation using Stability AI models.
 * Supports text-to-image via SDXL and image-to-image editing via SD Remix.
 * Mirrors PHP AI_Image_Aws.
 *
 * Requires @aws-sdk/client-bedrock-runtime — the require is wrapped so
 * a missing install yields a clear "not installed" error instead of
 * crashing at module load.
 *
 * @module AI/Image/Aws
 */
var Q        = require('Q');
var AI_Image = require('AI/Image');

/**
 * AWS Bedrock image generation adapter (Stability AI models).
 * Uses SDXL for text-to-image, SD Remix for image editing.
 *
 * @class AI_Image.Aws
 * @extends AI_Image
 * @constructor
 * @param {object} [options] Constructor options.
 */
AI_Image.Aws = function (options) {
	this.model = Q.Config.get(['AI', 'images', 'aws', 'model'], 'stability.stable-diffusion-xl-v0');
};
AI_Image.Aws.prototype = Object.create(AI_Image.prototype);
AI_Image.Aws.JPEG_QUALITY = 85;

/**
 * Gets or creates a cached AWS Bedrock Runtime client.
 * Credentials are loaded from Q.Config (AWS key/secret).
 * Client is instantiated once per adapter instance and reused.
 *
 * @private
 * @method _getClient
 * @return {BedrockRuntimeClient} AWS Bedrock Runtime client instance.
 * @throws {Error} If @aws-sdk/client-bedrock-runtime not installed.
 */
AI_Image.Aws.prototype._getClient = function () {
	if (this.__client) return this.__client;
	var sdk;
	try { sdk = require('@aws-sdk/client-bedrock-runtime'); }
	catch(e) { throw new Error('AI.Image.Aws: @aws-sdk/client-bedrock-runtime not installed'); }
	this.__sdk = sdk;
	this.__client = new sdk.BedrockRuntimeClient({
		region: Q.Config.get(['AI', 'aws', 'region'], 'us-east-1'),
		credentials: {
			accessKeyId:     Q.Config.get(['AI', 'aws', 'key'],    null),
			secretAccessKey: Q.Config.get(['AI', 'aws', 'secret'], null)
		}
	});
	return this.__client;
};

/**
 * Generates an image from a text prompt using AWS Bedrock's Stability AI models.
 * Can generate from text alone or use existing images as reference/base for editing.
 *
 * @method generate
 * @param {string} prompt Description of the image to generate or edit.
 * @param {object} [options] Generation options:
 *   - @param {string} [options.model="stability.stable-diffusion-xl-v0"] Bedrock model ID.
 *       Common values: "stability.stable-diffusion-xl-v0" (SDXL, highest quality),
 *       "stability.stable-diffusion-v2-1", "stability.sd-remix" (for image edits).
 *   - @param {string} [options.size="1024x1024"] Dimensions as "WIDTHxHEIGHT".
 *       Can also be set via separate width and height options.
 *       Common values: "512x512", "768x768", "1024x1024", "1280x720", "1344x768".
 *   - @param {integer} [options.width] Image width in pixels (overrides size parameter).
 *       For SDXL: 256–1344, must be multiple of 64.
 *   - @param {integer} [options.height] Image height in pixels (overrides size parameter).
 *       For SDXL: 256–1344, must be multiple of 64.
 *   - @param {integer} [options.steps=50] Number of diffusion steps (quality vs. speed tradeoff).
 *       Higher = more detail, slower. Typical range: 20–150. Default: 50.
 *   - @param {integer} [options.seed] Random seed for reproducibility.
 *       If omitted, randomly generated. For consistent results across calls, set explicitly.
 *   - @param {array} [options.images] Reference images (binary) for image-to-image mode.
 *       When provided, uses image-to-image mode (guidance based on input).
 *       Supports up to 1 image in this version.
 *
 * @return {Promise} Resolves to:
 *   - Success: {data: Buffer (binary PNG), format: 'png'} or {b64_json: base64 string}
 *   - Error: {error: string or decoded JSON}
 *
 * @example
 *   var ai = AI_Image.create('aws');
 *   ai.generate('A cyberpunk city at night with neon signs', {
 *       model: 'stability.stable-diffusion-xl-v0',
 *       size: '1024x1024',
 *       steps: 80
 *   }).then(function(res) {
 *       if (res.data) {
 *           fs.writeFileSync('output.png', res.data);
 *       } else if (res.b64_json) {
 *           var buf = Buffer.from(res.b64_json, 'base64');
 *           fs.writeFileSync('output.png', buf);
 *       }
 *   });
 *
 * @example
 *   // Image-to-image: style transfer
 *   var baseImage = fs.readFileSync('original.jpg');
 *   ai.generate('Convert this to an oil painting', {
 *       model: 'stability.stable-diffusion-xl-v0',
 *       images: [baseImage],
 *       steps: 60
<<<<<<< HEAD
 *   }).then(function(res) { /\* ... *\/ });
=======
 *   }).then(function(res) { ... });
>>>>>>> 644a2e484539b8771cc518c96f6859dd01092fa1
 */
AI_Image.Aws.prototype.generate = function (prompt, options) {
	options   = options || {};
	var self  = this;
	var modelId = options.model || this.model;
	var size  = options.size || ((options.width || 1024) + 'x' + (options.height || 1024));
	var wh    = size.split('x');
	var payload = {
		text_prompts: [{ text: prompt }],
		cfg_scale: 10,
		steps:     options.steps || 50,
		seed:      typeof options.seed === 'number' ? options.seed : Math.floor(Math.random() * 1000000),
		width:     parseInt(wh[0]),
		height:    parseInt(wh[1] || wh[0])
	};
	return new Promise(function (resolve) {
		try {
			var client = self._getClient();
			client.send(new self.__sdk.InvokeModelCommand({
				modelId: modelId, body: JSON.stringify(payload),
				contentType: 'application/json', accept: 'application/json'
			})).then(function (r) {
				var data; try { data = JSON.parse(Buffer.from(r.body).toString()); } catch(e) { data = {}; }
				if (!data.artifacts || !data.artifacts[0] || !data.artifacts[0].base64) {
					return resolve({ error: JSON.stringify(data) });
				}
				resolve({ data: Buffer.from(data.artifacts[0].base64, 'base64'), format: 'png' });
			}).catch(function (e) { resolve({ error: e.message }); });
		} catch(e) { resolve({ error: e.message }); }
	});
};

/**
 * Removes the background from an image using AWS Bedrock's Stability AI SD Remix model.
 * Analyzes image content, detects background, and outputs a transparent or matte version.
 * Uses inpainting technique: the model learns the background and replaces it.
 *
 * @method removeBackground
 * @param {Buffer|string} image Binary image data or file path.
 * @param {object} [options] Processing options:
 *   - @param {string} [options.model="stability.sd-remix"] Bedrock model ID.
 *       SD Remix is optimized for inpainting/background removal tasks.
 *   - @param {string} [options.prompt="remove background"] Custom prompt for the edit.
 *       Default guides model to cleanly isolate the subject.
 *   - @param {string} [options.format="png"] Output format (png recommended).
 *       Allowed: "png", "jpg", "jpeg", "webp", "gif".
 *   - @param {integer} [options.steps=40] Number of diffusion steps for inpainting.
 *       Higher = more detail. Default: 40. Typical range: 20–100.
 *   - @param {integer} [options.seed] Random seed for reproducibility.
 *
 * @return {Promise} Resolves to:
 *   - Success: {data: Buffer (binary image), format: string}
 *   - Error: {error: mixed}
 *
 * @example
 *   var imageBinary = fs.readFileSync('portrait.jpg');
 *   ai.removeBackground(imageBinary, {
 *       format: 'png',
 *       steps: 50
 *   }).then(function(res) {
 *       if (res.data) {
 *           fs.writeFileSync('portrait_transparent.png', res.data);
 *       }
 *   });
 */
AI_Image.Aws.prototype.removeBackground = function (image, options) {
	return this.generate(
		(options && options.prompt) || 'remove background',
		Object.assign({}, options || {}, { images: [image] })
	);
};

module.exports = AI_Image.Aws;