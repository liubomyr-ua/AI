'use strict';
/**
 * AI_Image_Aws → AI.Image.Aws
 * Adapter for AWS Bedrock image generation (Stable Diffusion et al).
 * Mirrors PHP AI_Image_Aws.
 *
 * Requires @aws-sdk/client-bedrock-runtime — the require is wrapped so
 * a missing install yields a clear "not installed" error instead of
 * crashing at module load.
 *
 * @module AI
 */
var Q        = require('Q');
var AI_Image = require('AI/Image');

AI_Image.Aws = function (options) {
	this.model = Q.Config.get(['AI', 'images', 'aws', 'model'], 'stability.stable-diffusion-xl-v0');
};
AI_Image.Aws.prototype = Object.create(AI_Image.prototype);
AI_Image.Aws.JPEG_QUALITY = 85;

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

AI_Image.Aws.prototype.generate = function (prompt, options) {
	options   = options || {};
	var self  = this;
	var modelId = options.model || this.model;
	var size  = options.size || '1024x1024';
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

AI_Image.Aws.prototype.removeBackground = function (image, options) {
	return this.generate(
		(options && options.prompt) || 'remove background',
		Object.assign({}, options || {}, { images: [image] })
	);
};

module.exports = AI_Image.Aws;
