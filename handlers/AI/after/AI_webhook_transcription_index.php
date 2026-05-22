<?php
/**
 * After-hook for AI/webhook/transcription/index.
 * Fires after the AI plugin has fetched the transcript and saved files.
 *
 * Updates the Safebox/transcription/{jobId} stream (created by Safebox/transcription POST)
 * to status='ready' so that downstream workflow steps are dispatched.
 * If no Safebox tracking stream exists this is a no-op.
 *
 * @module AI
 */
function AI_after_AI_webhook_transcription_index($params, $result)
{
	if (empty($result) || empty($result['id'])) {
		return;
	}

	$jobId      = $result['id'];
	$text       = Q::ifset($result, 'text',       '');
	$words      = Q::ifset($result, 'words',       array());
	$audioUrl   = Q::ifset($result, 'audio_url',  '');

	// Try to find a Safebox/transcription stream for this job ID.
	// It may be published under any communityId, so we search by stream name pattern.
	// Most efficiently: the stream is published under the community that submitted it.
	// We stored communityId in the stream attributes at creation time.
	// Simplest: search streams table for name = 'Safebox/transcription/{jobId}'.
	$streamName = 'Safebox/transcription/' . $jobId;

	// Fetch as Safebox (privileged) — we don't know the publisherId
	// so try the app community first, then fall back to a DB scan.
	$communityId = Users::communityId();
	$stream      = Streams_Stream::fetch('Safebox', $communityId, $streamName);
	if (!$stream) {
		// Scan — publisherId unknown; try app id
		$stream = Streams_Stream::fetch('Safebox', Q::app(), $streamName);
	}
	if (!$stream) {
		// Not a Safebox-managed transcription — nothing to update
		return;
	}

	// Cap words to avoid huge attribute blobs
	if (is_array($words) && count($words) > 2000) {
		$words = array_slice($words, 0, 2000);
	}

	$stream->setAttribute('Safebox/status',       'ready');
	$stream->setAttribute('Safebox/text',          substr((string)$text, 0, 65536));
	$stream->setAttribute('Safebox/words',         Q::json_encode($words));
	$stream->setAttribute('Safebox/audioUrl',      $audioUrl);
	$stream->save();

	// Notify waiting capability/tool sandboxes
	Streams_Message::post(
		$stream->publisherId,
		$stream->publisherId,
		$streamName,
		array(
			'type'         => 'Streams/changed',
			'instructions' => Q::json_encode(array('status' => 'ready')),
		),
		true
	);

	Q::log('[Safebox] transcription stream updated to ready: ' . $streamName, 'safebox');
}
