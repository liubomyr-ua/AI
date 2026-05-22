<?php

/**
 * AI_Voice_Xai — xAI Grok Voice Think Fast 1.0 broker.
 *
 * xAI's Voice Agent API is OpenAI-Realtime-compatible at the wire-format
 * level. Ephemeral tokens are issued via POST /v1/realtime/client_secrets
 * (same shape as OpenAI). Client connects via WebSocket; xAI doesn't
 * publish a WebRTC SDP endpoint as of May 2026 — for browser use, the
 * client connects over WebSocket with the ephemeral token as a subprotocol.
 *
 * Config:
 *   AI/xai/apiKey  — required
 *   AI/xai/baseUrl — default https://api.x.ai
 *
 * Voices available: ara, eve, leo (plus custom voices created via
 * POST /v1/custom-voices, which return voice_id usable here).
 *
 * Pricing notes: $0.05 / minute audio duration (May 2026), roughly half
 * the cost of OpenAI Realtime. Single TTFT under 1 second per Artificial
 * Analysis benchmarks.
 */
class AI_Voice_Xai extends AI_Voice
{
	protected $apiKey;
	protected $baseUrl;
	protected $defaults;

	function __construct($options = array())
	{
		$this->apiKey = isset($options['apiKey'])
			? $options['apiKey']
			: Q_Config::expect('AI', 'xai', 'apiKey');
		$this->baseUrl = rtrim(isset($options['baseUrl'])
			? $options['baseUrl']
			: Q_Config::get(array('AI', 'xai', 'baseUrl'), 'https://api.x.ai'), '/');
		$this->defaults = $options;
	}

	public function getProtocol() { return 'openai-realtime'; }  // same wire format

	public function createSession(array $params = array())
	{
		$cfg = array_replace($this->defaults, $params);
		$model = Q::ifset($cfg, 'model', 'grok-voice-think-fast-1.0');

		// OpenAI-compatible session config shape.
		$session = array(
			'type'  => 'realtime',
			'model' => $model
		);
		if (isset($cfg['voice']))          $session['voice']          = $cfg['voice'];
		if (isset($cfg['instructions']))   $session['instructions']   = $cfg['instructions'];
		if (isset($cfg['turn_detection'])) $session['turn_detection'] = $cfg['turn_detection'];
		if (isset($cfg['tools']))          $session['tools']          = $cfg['tools'];

		$audioFormat = Q::ifset($cfg, 'audioFormat', 'pcm16');
		$session['input_audio_format']  = $audioFormat;
		$session['output_audio_format'] = $audioFormat;
		if (isset($cfg['sampleRate'])) {
			$session['input_audio_sample_rate']  = $cfg['sampleRate'];
			$session['output_audio_sample_rate'] = $cfg['sampleRate'];
		}

		$response = Q_Utils::post(
			$this->baseUrl . '/v1/realtime/client_secrets',
			array('session' => $session),
			null,
			array(
				'CURLOPT_HTTPHEADER' => array(
					'Content-Type: application/json',
					'Authorization: Bearer ' . $this->apiKey
				),
				'CURLOPT_TIMEOUT' => 15
			)
		);

		if (!$response) {
			throw new Exception('AI_Voice_Xai: empty response from /v1/realtime/client_secrets');
		}
		$decoded = is_array($response) ? $response : json_decode($response, true);
		if (!is_array($decoded)) {
			throw new Exception('AI_Voice_Xai: non-JSON response: '
				. substr((string)$response, 0, 300));
		}
		if (isset($decoded['error'])) {
			$msg = is_array($decoded['error']) && isset($decoded['error']['message'])
				? $decoded['error']['message']
				: json_encode($decoded['error']);
			throw new Exception('AI_Voice_Xai error: ' . $msg);
		}

		// Response shape per xAI docs:
		//   { value: "...", expires_at: <unix>, session: {...} }
		$token = isset($decoded['value']) ? $decoded['value'] : null;
		if (!$token) {
			throw new Exception('AI_Voice_Xai: response missing "value" (ephemeral token)');
		}
		$expiresAt = isset($decoded['expires_at']) ? (int)$decoded['expires_at'] : (time() + 60);

		return array(
			'token'     => $token,
			'wsUrl'     => 'wss://api.x.ai/v1/realtime?model=' . urlencode($model),
			'wrtcUrl'   => null,  // xAI doesn't expose WebRTC as of May 2026
			'protocol'  => 'openai-realtime',
			'model'     => $model,
			'expiresAt' => $expiresAt,
			'mode'      => 'direct',
			'tokenSubprotocol' => 'xai-client-secret',  // browser WS subprotocol prefix
			'session'   => isset($decoded['session']) ? $decoded['session'] : $session
		);
	}
}
