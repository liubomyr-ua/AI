<?php

/**
 * AI_Voice_Openai — OpenAI Realtime API voice broker.
 *
 * Issues ephemeral tokens via POST /v1/realtime/client_secrets. The
 * browser then connects via WebRTC (preferred) or WebSocket using the
 * returned token.
 *
 * Config:
 *   AI/openAI/key   — required (server-side API key)
 *   AI/openAI/baseUrl  — default https://api.openai.com
 *
 * Per-call options accepted by createSession:
 *   model        — default 'gpt-realtime-2'
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
			: Q_Config::get(array('AI', 'openAI', 'baseUrl'), 'https://api.openai.com'), '/');
		$this->defaults = $options;
	}

	public function getProtocol() { return 'openai-realtime'; }

	public function createSession(array $params = array())
	{
		// Merge per-call params over adapter defaults
		$cfg = array_replace($this->defaults, $params);

		$model = Q::ifset($cfg, 'model', 'gpt-realtime-2');

		// Build the session config that the ephemeral token will be bound to.
		// Shape per OpenAI Realtime API spec (May 2026):
		//   POST /v1/realtime/client_secrets
		//   body: { session: { type, model, voice, instructions, ... } }
		$session = array(
			'type'  => 'realtime',
			'model' => $model
		);
		if (isset($cfg['voice']))          $session['voice']          = $cfg['voice'];
		if (isset($cfg['instructions']))   $session['instructions']   = $cfg['instructions'];
		if (isset($cfg['turn_detection'])) $session['turn_detection'] = $cfg['turn_detection'];
		if (isset($cfg['tools']))          $session['tools']          = $cfg['tools'];

		// Audio format/sample-rate go in input_audio_format / output_audio_format
		// per OpenAI's spec; the adapter normalizes shorthand.
		$audioFormat = Q::ifset($cfg, 'audioFormat', 'pcm16');
		$session['input_audio_format']  = $audioFormat;
		$session['output_audio_format'] = $audioFormat;

		$headers = array(
			'Content-Type: application/json',
			'Authorization: Bearer ' . $this->apiKey
		);
		// Bind a stable safety identifier if provided (for OpenAI safety routing).
		if (!empty($cfg['safetyIdentifier'])) {
			$headers[] = 'OpenAI-Safety-Identifier: ' . $cfg['safetyIdentifier'];
		}

		$response = Q_Utils::post(
			$this->baseUrl . '/v1/realtime/client_secrets',
			array('session' => $session),
			null,
			array(
				'CURLOPT_HTTPHEADER' => $headers,
				'CURLOPT_TIMEOUT'    => 15
			)
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
			'session'   => isset($decoded['session']) ? $decoded['session'] : $session
		);
	}
}
