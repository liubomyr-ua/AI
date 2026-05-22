'use strict';
/**
 * AI_Transcription_Aws → AI.Transcription.Aws
 * Async adapter — transcribe() submits a job, fetch() polls.
 * AWS Transcribe has no webhook — callers must use poll().
 * Mirrors PHP AI_Transcription_Aws.
 *
 * Requires @aws-sdk/client-transcribe — the require is wrapped so a
 * missing install yields a clear "not installed" error instead of
 * crashing at module load.
 *
 * @module AI
 */
var Q      = require('Q');
var path   = require('path');
var crypto = require('crypto');
var AI_Transcription = require('AI/Transcription');
var Http   = require('AI/Http');
var _get   = Http._get;

AI_Transcription.Aws = function (options) {};
AI_Transcription.Aws.prototype = Object.create(AI_Transcription.prototype);
AI_Transcription.Aws.prototype.platform = 'AWS Transcribe';

AI_Transcription.Aws.prototype._client = function () {
	if (this.__client) return this.__client;
	var sdk;
	try { sdk = require('@aws-sdk/client-transcribe'); }
	catch(e) { throw new Error('AI.Transcription.Aws: @aws-sdk/client-transcribe not installed'); }
	this.__sdk = sdk;
	this.__client = new sdk.TranscribeClient({
		region: Q.Config.get(['AI', 'aws', 'region'], 'us-east-1'),
		credentials: {
			accessKeyId:     Q.Config.get(['AI', 'aws', 'key'],    null),
			secretAccessKey: Q.Config.get(['AI', 'aws', 'secret'], null)
		}
	});
	return this.__client;
};

AI_Transcription.Aws.prototype.transcribe = function (source, options) {
	var self    = this;
	options     = options || {};
	var jobName = 'job_' + crypto.createHash('md5').update(source + Date.now()).digest('hex');
	var ext     = path.extname(source).replace('.', '') || 'mp3';

	return new Promise(function (resolve) {
		try {
			var client = self._client();
			client.send(new self.__sdk.StartTranscriptionJobCommand({
				TranscriptionJobName: jobName,
				MediaFormat:          ext,
				Media:                { MediaFileUri: source },
				LanguageCode:         options.language_code || 'en-US'
			})).then(function () {
				resolve({ id: jobName, status: 'SUBMITTED', platform: self.platform });
			}).catch(function (e) {
				resolve({ id: jobName, status: 'FAILED', error: e.message });
			});
		} catch(e) {
			resolve({ error: e.message });
		}
	});
};

AI_Transcription.Aws.prototype.fetch = function (transcriptId, options) {
	var self = this;
	return new Promise(function (resolve) {
		try {
			var client = self._client();
			client.send(new self.__sdk.GetTranscriptionJobCommand({
				TranscriptionJobName: transcriptId
			})).then(function (result) {
				var job    = result.TranscriptionJob;
				var status = job.TranscriptionJobStatus;
				if (status !== 'COMPLETED') {
					return resolve({ id: transcriptId, status: status });
				}
				_get(job.Transcript.TranscriptFileUri, {}, 30000).then(function (res) {
					var data; try { data = JSON.parse(res.body); } catch(e) { data = {}; }
					resolve({
						id:     transcriptId,
						status: 'COMPLETED',
						text:   (data.results && data.results.transcripts &&
						         data.results.transcripts[0] &&
						         data.results.transcripts[0].transcript) || '',
						words:  (data.results && data.results.items) || []
					});
				}).catch(function (e) {
					resolve({ id: transcriptId, status: 'COMPLETED',
						error: 'failed to fetch transcript file: ' + e.message });
				});
			}).catch(function (e) {
				resolve({ error: e.message });
			});
		} catch(e) {
			resolve({ error: e.message });
		}
	});
};

module.exports = AI_Transcription.Aws;
