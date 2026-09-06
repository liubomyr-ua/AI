<?php

/**
 * AI_Voice_AzureOpenai — Azure OpenAI Service Realtime API broker.
 *
 * Same wire format as OpenAI Realtime, but with Azure-specific endpoint
 * (per-resource URL) and auth (api-key header OR Microsoft Entra ID token).
 *
 * Ephemeral token issuance:
 *   POST {endpoint}/openai/v1/realtime/client_secrets?api-version=...
 *
 * Then browser connects via WebRTC or WebSocket using the returned token.
 *
 * Config:
 *   AI/azureOpenai/endpoint   — required, e.g. https://your-resource.openai.azure.com
 *   AI/azureOpenai/apiKey     — required (or use Entra ID — set entraToken instead)
 *   AI/azureOpenai/apiVersion — default 2024-10-01-preview
 *   AI/azureOpenai/deployment — required, name of the realtime deployment
 *
 * Note: Azure has strict regional availability for Realtime (East US 2,
 * Sweden Central as of late 2025). Other regions return 403.
 */
class AI_Voice_AzureOpenai extends AI_Voice
{
	protected $endpoint;
	protected $apiKey;
	protected $entraToken;
	protected $apiVersion;
	protected $defaults;

	function __construct($options = array())
	{
		$this->endpoint = rtrim(isset($options['endpoint'])
			? $options['endpoint']
			: Q_Config::expect('AI', 'azureOpenai', 'endpoint'), '/');
		$this->apiKey = isset($options['apiKey'])
			? $options['apiKey']
			: Q_Config::get('AI', 'azureOpenai', 'apiKey', null);
		$this->entraToken = isset($options['entraToken'])
			? $options['entraToken']
			: Q_Config::get('AI', 'azureOpenai', 'entraToken', null);
		if (!$this->apiKey && !$this->entraToken) {
			throw new Exception('AI_Voice_AzureOpenai: apiKey or entraToken required');
		}
		$this->apiVersion = isset($options['apiVersion'])
			? $options['apiVersion']
			: Q_Config::get('AI', 'azureOpenai', 'apiVersion', '2024-10-01-preview');
		$this->defaults = $options;
	}

	public function getProtocol() { return 'openai-realtime'; }

	public function createSession(array $params = array())
	{
		$cfg = array_replace($this->defaults, $params);
		$deployment = Q::ifset($cfg, 'deployment',
			Q_Config::expect('AI', 'azureOpenai', 'deployment'));

		// Wire shape per the current OpenAI Realtime API (same as
		// AI_Voice_Openai -- see its createSession() for the full rationale):
		// audio settings nest under audio.input / audio.output, "modalities"
		// is "output_modalities", and format is {type, rate} not a flat
		// shorthand string.
		$session = array(
			'type'  => 'realtime',
			'model' => $deployment
		);
		if (isset($cfg['instructions']))   $session['instructions']      = $cfg['instructions'];
		if (isset($cfg['tools']))          $session['tools']             = $cfg['tools'];
		if (isset($cfg['tool_choice']))    $session['tool_choice']       = $cfg['tool_choice'];
		if (isset($cfg['modalities']))     $session['output_modalities'] = $cfg['modalities'];

		// Session tracing -- see AI_Voice_Openai::createSession() for the
		// full rationale. Defaults on via AI/azureOpenai/realTime/tracing config.
		$tracing = array_key_exists('tracing', $cfg)
			? $cfg['tracing']
			: Q_Config::get('AI', 'azureOpenai', 'realTime', 'tracing', true);
		if ($tracing === true) {
			$session['tracing'] = 'auto';
		} elseif ($tracing === false) {
			$session['tracing'] = null;
		} else {
			$session['tracing'] = $tracing;
		}

		$audioFormat = Q::ifset($cfg, 'audioFormat', 'pcm16');
		$sampleRate  = Q::ifset($cfg, 'sampleRate', 24000);
		$inputFormat  = is_array($audioFormat) ? $audioFormat : array('type' => 'audio/pcm', 'rate' => $sampleRate);
		// Output requires "rate" too -- the API rejects output.format
		// without one, even though the docs' own example omits it.
		$outputFormat = is_array($audioFormat) ? $audioFormat : array('type' => 'audio/pcm', 'rate' => $sampleRate);

		$audioInput = array('format' => $inputFormat);
		// array_key_exists, not isset -- turn_detection:null is meaningful
		// (disables VAD for manual/push-to-talk turn control).
		if (array_key_exists('turn_detection', $cfg)) $audioInput['turn_detection'] = $cfg['turn_detection'];
		if (isset($cfg['input_audio_transcription']))  $audioInput['transcription']  = $cfg['input_audio_transcription'];

		$audio = array('input' => $audioInput);

		// Skip audio.output entirely when the caller only wants text back --
		// see AI_Voice_Openai::createSession() for the full rationale.
		$modalities = isset($cfg['modalities']) ? (array)$cfg['modalities'] : null;
		$wantsAudioOut = !$modalities || in_array('audio', $modalities);
		if ($wantsAudioOut) {
			$audioOutput = array('format' => $outputFormat);
			if (isset($cfg['voice'])) $audioOutput['voice'] = $cfg['voice'];
			$audio['output'] = $audioOutput;
		}

		$session['audio'] = $audio;

		$headers = array('Content-Type: application/json');
		if ($this->apiKey) {
			$headers[] = 'api-key: ' . $this->apiKey;
		} else {
			$headers[] = 'Authorization: Bearer ' . $this->entraToken;
		}

		$url = $this->endpoint . '/openai/v1/realtime/client_secrets?api-version='
			. urlencode($this->apiVersion);

		// Q_Utils::post($url, $data, $user_agent, $curl_opts, $header, $timeout, ...)
		// -- $curl_opts keys must be real CURLOPT_* constants (merged
		// straight into curl_setopt_array()); headers/timeout have their own
		// dedicated params instead.
		$response = Q_Utils::post($url, array('session' => $session), null, array(), $headers, 15);
		if (!$response) {
			throw new Exception('AI_Voice_AzureOpenai: empty response');
		}
		$decoded = is_array($response) ? $response : json_decode($response, true);
		if (!is_array($decoded)) {
			throw new Exception('AI_Voice_AzureOpenai: non-JSON response: '
				. substr((string)$response, 0, 300));
		}
		if (isset($decoded['error'])) {
			$msg = is_array($decoded['error']) && isset($decoded['error']['message'])
				? $decoded['error']['message']
				: json_encode($decoded['error']);
			throw new Exception('AI_Voice_AzureOpenai error: ' . $msg);
		}

		$token = isset($decoded['value']) ? $decoded['value'] : null;
		if (!$token) {
			throw new Exception('AI_Voice_AzureOpenai: response missing ephemeral token');
		}
		$expiresAt = isset($decoded['expires_at']) ? (int)$decoded['expires_at'] : (time() + 60);

		// Azure WebSocket URL uses the deployment-scoped path.
		$wsHost = preg_replace('#^https?://#', '', $this->endpoint);
		$wsUrl  = 'wss://' . $wsHost . '/openai/realtime?deployment=' . urlencode($deployment)
			. '&api-version=' . urlencode($this->apiVersion);

		return array(
			'token'     => $token,
			'wsUrl'     => $wsUrl,
			'wrtcUrl'   => $this->endpoint . '/openai/realtime?deployment=' . urlencode($deployment),
			'protocol'  => 'openai-realtime',
			'model'     => $deployment,
			'expiresAt' => $expiresAt,
			'mode'      => 'direct',
			// Always our own constructed $session, never $decoded['session']
			// -- see AI_Voice_Openai::createSession() for the full rationale.
			'session'   => $session
		);
	}
}
