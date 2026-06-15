<?php
/**
 * AI/before/Q_responseExtras
 *
 * Loaded once per response. Adds the browser-side AI.js bootstrap to the
 * page (it installs the configured Q.Speech.Recognition backend on
 * Q.onInit) and injects the speech-provider config that AI.js reads.
 *
 * Server config keys consulted:
 *   AI/speech/provider     'deepgram' | 'browser' | null   (default: null)
 *   AI/speech/sampleRate   integer, default 16000
 *   AI/speech/chunkMs      integer, default 100
 *
 * Setting AI/speech/provider to null leaves the browser's native
 * SpeechRecognition in place — no install happens. Setting it to
 * 'deepgram' makes AI.js load the Deepgram adapter on activate and
 * route Q.Speech.Recognition.start() through it.
 *
 * Heuristic fallback: if AI/speech/provider is not set explicitly but
 * a Deepgram API key is configured under AI/deepgram/key, the speech
 * provider is treated as 'deepgram'. This mirrors the server-side
 * convention in AI.js _openTranscription.
 */
function AI_before_Q_responseExtras()
{
    Q_Response::addScript('{{AI}}/js/AI.js', 'AI');

    $provider = Q_Config::get('AI', 'speech', 'provider', null);
    if ($provider === null && Q_Config::get('AI', 'deepgram', 'key', null)) {
        $provider = 'deepgram';
    }

    Q_Response::setScriptData('Q.plugins.AI.speech', array(
        'provider'   => $provider,
        'sampleRate' => Q_Config::get('AI', 'speech', 'sampleRate', 16000),
        'chunkMs'    => Q_Config::get('AI', 'speech', 'chunkMs',    100),
    ));
}
