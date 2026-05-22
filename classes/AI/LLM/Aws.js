'use strict';
/**
 * AI_LLM_Aws → AI.LLM.Aws
 * AWS Bedrock adapter (Claude via @aws-sdk/client-bedrock-runtime).
 * Mirrors PHP AI_LLM_Aws.
 *
 * Requires @aws-sdk/client-bedrock-runtime — the require is wrapped so
 * a missing install yields a clear "not installed" error instead of
 * crashing at module load.
 *
 * @module AI
 */
var Q      = require('Q');
var AI_LLM = require('AI/LLM');

AI_LLM.Aws = function(options) {
	this.modelId = Q.Config.get(['AI', 'llm', 'models', 'aws'],
		Q.Config.get(['AI', 'aws', 'llm_model_id'],
			'anthropic.claude-3-sonnet-20240229-v1:0'));
};
AI_LLM.Aws.prototype = Object.create(AI_LLM.prototype);

AI_LLM.Aws.prototype._client = function() {
	if (this.__client) return this.__client;
	var BedrockRuntimeClient, InvokeModelCommand;
	try {
		var sdk = require('@aws-sdk/client-bedrock-runtime');
		BedrockRuntimeClient = sdk.BedrockRuntimeClient;
		InvokeModelCommand   = sdk.InvokeModelCommand;
	} catch(e) {
		throw new Error('AI.LLM.Aws: @aws-sdk/client-bedrock-runtime not installed');
	}
	this.__client = new BedrockRuntimeClient({
		region:      Q.Config.get(['AI', 'aws', 'region'], 'us-east-1'),
		credentials: {
			accessKeyId:     Q.Config.get(['AI', 'aws', 'key'],    null),
			secretAccessKey: Q.Config.get(['AI', 'aws', 'secret'], null)
		}
	});
	this.__InvokeModelCommand = InvokeModelCommand;
	return this.__client;
};

AI_LLM.Aws.prototype.executeModel = function(instructions, inputs, options) {
	options = options || {};
	var self       = this;
	var modelId    = options.model      || this.modelId;
	var temperature = options.temperature != null ? options.temperature : 0.5;
	var maxTokens   = options.max_tokens  || 3000;
	var rf = options.response_format, js = options.json_schema;

	var systemPrompt = '';
	if (rf === 'json_schema' && js) {
		systemPrompt += 'You are a strict JSON generator.\nOutput MUST be valid JSON and MUST conform exactly to this JSON Schema:\n\n' +
			JSON.stringify(js, null, 2) + '\n\nRules:\n- Output JSON only\n- No prose, comments, or markdown\n- No omit required fields\n- Use null when a value is unknown\n\n';
	} else if (rf === 'json') {
		systemPrompt += 'You are a strict JSON generator.\nOutput MUST be valid JSON.\nDo not include prose, comments, or markdown.\n\n';
	}
	if (instructions) systemPrompt += instructions;

	var messages = options.messages ? options.messages.map(function(m) {
		if (m.role === 'tool') return { role: 'assistant', content: typeof m.content === 'string'
			? [{ type: 'text', text: m.content }] : m.content };
		var c = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
		return { role: m.role || 'user', content: c };
	}) : [];

	if (!messages.length && inputs && inputs.text) {
		messages.push({ role: 'user', content: [{ type: 'text', text: inputs.text }] });
	}

	var payload = {
		anthropic_version: 'bedrock-2023-05-31',
		system:     systemPrompt,
		messages:   messages,
		max_tokens: maxTokens,
		temperature: temperature,
		top_k: 250,
		top_p: 0.999
	};

	return new Promise(function(resolve, reject) {
		try {
			var client = self._client();
			client.send(new self.__InvokeModelCommand({
				modelId:     modelId,
				body:        JSON.stringify(payload),
				contentType: 'application/json',
				accept:      'application/json'
			})).then(function(response) {
				var body = Buffer.from(response.body).toString();
				var data; try { data = JSON.parse(body); } catch(e) {
					return reject(new Error('AI.LLM.Aws: non-JSON response'));
				}
				if (data.completion) return resolve(data.completion.trim());
				if (data.content && data.content[0] && data.content[0].text) {
					return resolve(data.content[0].text.trim());
				}
				resolve('');
			}).catch(reject);
		} catch(e) { reject(e); }
	});
};

module.exports = AI_LLM.Aws;
