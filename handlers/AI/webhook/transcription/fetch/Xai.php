<?php

/**
 * Webhook handler: receives xAI transcription results from Node.
 *
 * Node POSTs { Q.jobId, Q.echo, result } to this endpoint when an
 * AI/Transcription/Xai/transcribe job completes. The echo was signed
 * by Q_Utils::sendToNode when the job was submitted, so we validate it
 * here before trusting any of its contents — this prevents a
 * compromised or impersonated Node from feeding us fake routing info.
 *
 * Once validated, $echo carries whatever context the original caller
 * stashed. By default that's the original $options array. Extend this
 * handler to do whatever your app needs with the transcript: write it
 * to a Streams/task stream, emit a socket event, post a message, etc.
 *
 * Route: AI/webhook/transcription/fetch/Xai
 *   (matches the default _webhook path in AI_Transcription_Xai::transcribe)
 *
 * @module AI
 */
function AI_webhook_transcription_fetch_Xai($params)
{
	Q_Request::handleInput();

	// Q_Request::special() handles dotted-vs-underscored keys transparently
	// (PHP converts dots in POST field names to underscores).
	$jobId   = Q_Request::special('jobId');
	$echoSig = Q_Request::special('echo');
	$result  = Q::ifset($_REQUEST, 'result', null);

	// result may arrive JSON-encoded inside a form field
	if (is_string($result)) {
		$decoded = json_decode($result, true);
		if (is_array($decoded)) {
			$result = $decoded;
		}
	}
	// echoSig similarly
	if (is_string($echoSig)) {
		$decoded = json_decode($echoSig, true);
		if (is_array($decoded)) {
			$echoSig = $decoded;
		}
	}

	if (!$jobId || !is_array($result)) {
		return '';
	}

	// Validate the echo signature. Q_Utils::sign() stored the echo as
	// { echo: <original>, Q: { sig: <hmac> } } — rebuild that wrapper and
	// re-sign, then compare against what Node sent back.
	$echo = null;
	if (is_array($echoSig) && isset($echoSig['echo'])) {
		$sigField = Q_Config::get('Q', 'internal', 'sigField', 'sig');
		$provided = Q::ifset($echoSig, 'Q', $sigField, null);
		if ($provided) {
			$toVerify = array('echo' => $echoSig['echo']);
			$expected = Q_Utils::signature($toVerify);
			if (Q_Utils::hashEquals($expected, $provided)) {
				$echo = $echoSig['echo'];
			}
		}
	}

	if ($echo === null) {
		Q::log("AI/webhook/transcription/fetch/Xai: echo signature invalid for jobId=$jobId");
		return '';
	}

	// $echo now contains whatever the original caller stashed (by default,
	// the original $options array). Do your post-processing here.
	//
	// Typical pattern:
	//   $publisherId = Q::ifset($echo, 'publisherId', null);
	//   $streamName  = Q::ifset($echo, 'streamName', null);
	//   if ($publisherId && $streamName) {
	//       $stream = Streams::fetchOne($publisherId, $publisherId, $streamName);
	//       if ($stream) {
	//           $stream->setAttribute('Xai/transcript', $result);
	//           $stream->save();
	//       }
	//   }

	// Fire an event so apps can hook into transcription completion.
	Q::event('AI/Transcription/Xai/fetched', array(
		'jobId'  => $jobId,
		'echo'   => $echo,
		'result' => $result
	));

	return $result;
}
