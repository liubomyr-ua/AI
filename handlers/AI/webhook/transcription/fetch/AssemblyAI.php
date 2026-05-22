<?php

function AI_webhook_transcription_fetch_AssemblyAI($params)
{
    Q_Request::handleInput();
    $id = Q::ifset($_REQUEST, 'transcript_id', null);
    if (!$id || Q::ifset($_REQUEST, 'status', null) !== 'completed') {
        return '';
    }
    $t = new AI_Transcription_Assemblyai();
    return $t->fetch($id);
}