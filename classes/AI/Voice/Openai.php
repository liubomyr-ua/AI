<?php

/**
 * AI_Voice_Openai — OpenAI Realtime API voice broker.
 *
 * Issues ephemeral tokens via POST /v1/realtime/client_secrets. The
 * browser then connects via WebRTC (preferred) or WebSocket using the
 * returned token.
 *
 * Config:
 *   AI/openAI/key             — required (server-side API key)
 *   AI/openAI/baseUrl         — default https://api.openai.com
 *   AI/openAI/realTime/model    — default 'gpt-realtime-2.1-mini'
 *   AI/openAI/realTime/tracing  — default true (see createSession() below)
 *
 * Per-call options accepted by createSession:
 *   model        — overrides AI/openAI/realTime/model config for this call
 *   voice        — default 'alloy'
 *   instructions — system prompt
 *   audioFormat  — 'pcm16' (default)
 *   sampleRate   — 24000 (default)
 *   turn_detection
 *   tools
 *   ttl          — requested token lifetime seconds
 */
class AI_Voice_Openai extends AI_Voice
{
	protected $apiKey;
	protected $baseUrl;
	protected $defaults;

	function __construct($options = array())
	{
		$this->apiKey = isset($options['apiKey'])
			? $options['apiKey']
			: Q_Config::expect('AI', 'openAI', 'key');
		$this->baseUrl = rtrim(isset($options['baseUrl'])
			? $options['baseUrl']
			: Q_Config::get('AI', 'openAI', 'baseUrl', 'https://api.openai.com'), '/');
		$this->defaults = $options;
	}

	public function getProtocol() { return 'openai-realtime'; }

	public function createSession(array $params = array())
	{
		// Merge per-call params over adapter defaults
		$cfg = array_replace($this->defaults, $params);

		$model = Q::ifset($cfg, 'model', Q_Config::get('AI', 'openAI', 'realTime', 'model', 'gpt-realtime-2.1-mini'));

		// Build the session config that the ephemeral token will be bound to.
		// Wire shape per the current OpenAI Realtime API (session GA
		// restructuring): audio settings moved off the session root into a
		// nested audio.input / audio.output object, "modalities" was renamed
		// "output_modalities", and audio format went from a flat shorthand
		// string ('pcm16') to an object ({type, rate}). This adapter's own
		// per-call option names (voice, turn_detection, audioFormat, ...)
		// stay the same as before -- only the internal mapping below needs
		// to track OpenAI's wire format if it changes again.
		//   POST /v1/realtime/client_secrets
		//   body: { session: { type, model, instructions, output_modalities,
		//                       tools, tool_choice, audio: {input, output} } }
		$session = array(
			'type'  => 'realtime',
			'model' => $model
		);
		if (isset($cfg['instructions']))   $session['instructions']      = $cfg['instructions'];
		if (isset($cfg['tools']))          $session['tools']             = $cfg['tools'];
		if (isset($cfg['tool_choice']))    $session['tool_choice']       = $cfg['tool_choice'];
		if (isset($cfg['modalities']))     $session['output_modalities'] = $cfg['modalities'];

		// Session tracing -- lets a session's activity show up on the
		// Realtime API Logs dashboard (platform.openai.com/logs?api=realtime).
		// "auto" turns it on with default workflow/group/metadata; null
		// turns it off. Defaults on via AI/openAI/realTime/tracing config,
		// overridable per call via $cfg['tracing'] (true/false, or already-
		// "auto"/null/a granular {group_id, metadata, workflow_name} object).
		$tracing = array_key_exists('tracing', $cfg)
			? $cfg['tracing']
			: Q_Config::get('AI', 'openAI', 'realTime', 'tracing', true);
		if ($tracing === true) {
			$session['tracing'] = 'auto';
		} elseif ($tracing === false) {
			$session['tracing'] = null;
		} else {
			$session['tracing'] = $tracing; // already "auto" / null / a granular object
		}

		$audioFormat = Q::ifset($cfg, 'audioFormat', 'pcm16');
		$sampleRate  = Q::ifset($cfg, 'sampleRate', 24000);
		// Only 'pcm16' (this adapter's only shorthand so far) is normalized
		// to the new {type, rate} shape; an already-object format passes
		// through unchanged for forward compatibility.
		$inputFormat  = is_array($audioFormat) ? $audioFormat : array('type' => 'audio/pcm', 'rate' => $sampleRate);
		// Output requires "rate" too -- the API rejects output.format
		// without one, even though the docs' own example omits it.
		$outputFormat = is_array($audioFormat) ? $audioFormat : array('type' => 'audio/pcm', 'rate' => $sampleRate);

		$audioInput = array('format' => $inputFormat);
		// array_key_exists, not isset -- turn_detection:null is a meaningful
		// value (disables VAD for manual/push-to-talk turn control), and
		// isset() treats an explicit null the same as "not passed at all".
		if (array_key_exists('turn_detection', $cfg)) $audioInput['turn_detection'] = $cfg['turn_detection'];
		if (isset($cfg['input_audio_transcription']))  $audioInput['transcription']  = $cfg['input_audio_transcription'];

		$audio = array('input' => $audioInput);

		// Skip audio.output entirely when the caller only wants text back
		// (e.g. Safebots' report_visualization flow) -- there's no spoken
		// reply to configure a format/voice for, and this is also one fewer
		// thing that can fail the request's schema validation.
		$modalities = isset($cfg['modalities']) ? (array)$cfg['modalities'] : null;
		$wantsAudioOut = !$modalities || in_array('audio', $modalities);
		if ($wantsAudioOut) {
			$audioOutput = array('format' => $outputFormat);
			if (isset($cfg['voice'])) $audioOutput['voice'] = $cfg['voice'];
			$audio['output'] = $audioOutput;
		}

		$session['audio'] = $audio;

		$headers = array(
			'Content-Type: application/json',
			'Authorization: Bearer ' . $this->apiKey
		);
		// Bind a stable safety identifier if provided (for OpenAI safety routing).
		if (!empty($cfg['safetyIdentifier'])) {
			$headers[] = 'OpenAI-Safety-Identifier: ' . $cfg['safetyIdentifier'];
		}

		// Q_Utils::post($url, $data, $user_agent, $curl_opts, $header, $timeout, ...)
		// -- $curl_opts keys must be real CURLOPT_* constants (it's merged
		// straight into curl_setopt_array()); headers and timeout have their
		// own dedicated params instead.
		$response = Q_Utils::post(
			$this->baseUrl . '/v1/realtime/client_secrets',
			array('session' => $session),
			null,
			array(),
			$headers,
			15
		);

		if (!$response) {
			throw new Exception('AI_Voice_Openai: empty response from client_secrets endpoint');
		}
		$decoded = is_array($response) ? $response : json_decode($response, true);
		if (!is_array($decoded)) {
			throw new Exception('AI_Voice_Openai: non-JSON response: '
				. substr((string)$response, 0, 300));
		}
		if (isset($decoded['error'])) {
			$msg = is_array($decoded['error']) && isset($decoded['error']['message'])
				? $decoded['error']['message']
				: json_encode($decoded['error']);
			throw new Exception('AI_Voice_Openai error: ' . $msg);
		}

		// Response shape (May 2026):
		//   { value: "ek_...", expires_at: <unix>, session: {...} }
		$token = isset($decoded['value']) ? $decoded['value'] : null;
		if (!$token) {
			throw new Exception('AI_Voice_Openai: response missing "value" (ephemeral token): '
				. substr((string)$response, 0, 300));
		}
		$expiresAt = isset($decoded['expires_at']) ? (int)$decoded['expires_at'] : (time() + 60);

		return array(
			'token'     => $token,
			'wsUrl'     => 'wss://api.openai.com/v1/realtime?model=' . urlencode($model),
			'wrtcUrl'   => 'https://api.openai.com/v1/realtime/calls',
			'protocol'  => 'openai-realtime',
			'model'     => $model,
			'expiresAt' => $expiresAt,
			'mode'      => 'direct',
			// Always our own constructed $session, never $decoded['session']:
			// the client resends this verbatim as the `session.update` event
			// payload once connected (see AI.Voice.OpenaiRealtime's dc.onopen),
			// but OpenAI's client_secrets response echoes back a full session
			// RESOURCE representation -- with server-generated fields like
			// "object" -- that session.update's event schema rejects.
			'session'   => $session
		);
	}
}
