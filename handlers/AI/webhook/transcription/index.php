<?php

function AI_webhook_transcription_index($params)
{
    $fetched = Q::event("AI/webhook/transcription/fetch/".$params['platform']);
    $basename = Q::ifset($_REQUEST, 'basename', basename($fetched['audio_url']));
    $path = APP_FILES_DIR . DS . 'AI' . DS . 'transcriptions';
    if (!file_exists($path)) {
        mkdir($path, 0777, true);
    }
    $lines = '';
    foreach ($fetched['utterances'] as $u) {
        $line = !empty($fetched['speaker_labels'])
            ? "$u[speaker]: $u[text]"
            : $u['text'];
        $start = $u['start'];
        $end = $u['end'];
        $entries[] = compact('line', 'start', 'end');
        $hms = Q_Utils::secondsToHMS($start / 1000);
        $lines .= "$hms | " . $line . "\n";
    }
    file_put_contents($path . DS . "$basename.transcript", $lines);
    $count = count($entries);
    $chunks = array_chunk($entries, ceil($count/10), true);
    $result = '';
    foreach ($chunks as $chunk) {
        $source = '';
        foreach ($chunk as $entry) {
            $source .= $entry['line'] . "\n";
        }
        if (!trim($source)) {
            continue;
        }
        $first = reset($chunk);
        $last = end($chunk);
        $start = $first['start'];
        $end = $last['end'];
        $LLM = new AI_LLM_Openai();
        $results = $LLM->summarize($source);
        $keywords = $LLM->keywords($results['keywords']);
        $s = floor($start / 1000);
        $hms = Q_Utils::secondsToHMS($s);
        $result .= "[$hms]"
            . "\n" . json_encode($keywords)
            . "\n" . $results['summary'] . PHP_EOL . PHP_EOL;
    }
    file_put_contents($path . DS . "$basename.summary", $result);
}