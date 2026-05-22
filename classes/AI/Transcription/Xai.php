<?php

/**
 * xAI transcription adapter (PHP-side shim).
 *
 * Named "Xai" (company) rather than "Grok" (product) to match the plugin's
 * factory convention: adapters correspond to API providers, not specific
 * models. If xAI ships additional STT models later, they're selected via
 * $options['model'] without needing a new adapter class.
 *
 * This adapter does NOT call xAI directly. xAI STT is synchronous at the
 * HTTP layer and the call blocks for seconds on long audio, which would
 * pin a PHP-FPM worker. Instead, transcribe() delegates to the Node-side
 * adapter via Q_Utils::sendToNode with a webhook + echo, and returns
 * immediately with the caller-minted job id. Node does the multipart
 * upload to api.x.ai and POSTs the result back to the webhook URL, with
 * the echo context attached untouched.
 *
 * The corresponding Node-side adapter is AI.Transcription.Xai (see
 * classes/AI/Transcription.js), registered against the framework IPC
 * dispatcher in AI.listen (see classes/AI.js).
 *
 * Webhook handler: handlers/AI/webhook/transcription/fetch/Xai.php
 *
 * Configuration:
 *   AI/xai/key       — xAI API key (used by the Node adapter)
 *   Q/ipc/echoMaxBytes — max size of the echo context blob (default 8192)
 *
 * See: https://docs.x.ai/developers/model-capabilities/audio/speech-to-text
 *
 * @class AI_Transcription_Xai
 * @extends AI_Transcription
 * @implements AI_Transcription_Interface
 */
class AI_Transcription_Xai extends AI_Transcription implements AI_Transcription_Interface
{
	/**
	 * Submit a transcription job to Node for async processing.
	 *
	 * @method transcribe
	 * @param {string} $source publicly accessible URL of audio/video to transcribe.
	 * @param {array} $options
	 * @param {array} [$options._diarization] Enable speaker diarization.
	 * @param {integer} [$options._diarization.max] Max speakers expected.
	 * @param {boolean} [$options.format=false] Inverse text normalization.
	 * @param {string} [$options.language] ISO language code; omit to auto-detect.
	 * @param {boolean} [$options.diarize] Native xAI flag.
	 * @param {string} [$options.model] Override the default STT model.
	 * @param {array} [$options._echo] Opaque context the webhook will receive
	 *   untouched. Defaults to an array containing the original $options so
	 *   the webhook handler has context to route the result. Pass e.g.
	 *   ['publisherId' => $p, 'streamName' => $s, 'userId' => $u] here
	 *   to round-trip stream/user context without a lookup table.
	 * @param {string} [$options._webhook] Route path for the PHP webhook
	 *   handler; defaults to 'AI/webhook/transcription/fetch/Xai'. Can also
	 *   be a full URL for cross-host setups.
	 * @return {array}
	 *   On success: { id: <jobId>, status: 'QUEUED', platform: 'xAI' }
	 *   On IPC failure: { status: 'FAILED', error: <message>, platform: 'xAI' }
	 */
	function transcribe($source, $options = array())
	{
		// Pull out framework/cross-provider hints so they're not passed to
		// Node as part of the STT payload.
		$echo    = Q::ifset($options, '_echo', array('options' => $options));
		$webhook = Q::ifset($options, '_webhook', 'AI/webhook/transcription/fetch/Xai');
		unset($options['_echo'], $options['_webhook']);

		$jobId = Q_Utils::sendToNode(
			array(
				'Q/method' => 'AI/Transcription/Xai/transcribe',
				'source'   => $source,
				'options'  => $options
			),
			null,
			array(
				'job'     => true,
				'webhook' => $webhook,
				'echo'    => $echo
			)
		);

		if ($jobId === false) {
			return array(
				'status'   => 'FAILED',
				'error'    => 'Node IPC unreachable; xAI transcription could not be submitted',
				'platform' => $this->platform
			);
		}

		return array(
			'id'       => $jobId,
			'status'   => 'QUEUED',
			'platform' => $this->platform
		);
	}

	/**
	 * Fetch a previously-submitted transcription.
	 *
	 * Results are delivered via webhook rather than stored in this process,
	 * so callers should subscribe to the relevant Streams/task stream (or
	 * whatever durable store the webhook handler writes to) rather than
	 * polling fetch(). This method returns NOT_FOUND for unknown ids; wire
	 * it to read from your durable store of choice if you need fetch() to
	 * return actual transcripts.
	 *
	 * @method fetch
	 * @param {string} $transcriptId
	 * @return {array}
	 */
	function fetch($transcriptId, $options = array())
	{
		return array(
			'id'     => $transcriptId,
			'status' => 'NOT_FOUND'
		);
	}

	/**
	 * Platform name.
	 */
	public $platform = 'xAI';
}
