<?php

interface AI_Transcription_Interface
{
    function transcribe($source, $options = array());

    function fetch($transcriptId);
}

class AI_Transcription implements AI_Transcription_Interface
{
    /**
     * @method transcribe
     * @static
     * @param {string} $source a publicly accessible URL of the audio or video file to transcribe.
     * @param {array} $options any options for the specific service,
     *   or the following standard options:
     * @param {array} [$options._diarization=] Enable speaker diarization. 
     * @param {array} [$options._diarization.max=] Maximum number of speakers expected (up to 10). 
     */
    function transcribe($source, $options = array())
    {
        // by default, return an empty array
        return array();
    }

    /**
     * Fetch an already-generated transcript
     * @method fetch
     * @static
     * @param {string} $transcriptId
     * @return {array} Returns the generated transcript as a PHP array.
     */
    function fetch($transcriptId)
    {
        // by default, return an empty array
        return array();
    }

    /**
     * Create an Transcription adapter instance from a string or return an existing instance.
     *
     * @method create
     * @static
     * @param {String|Object} adapter Adapter name, FQCN, or instance
     * @param {Object} [options] Optional constructor/options to pass to adapter
     * @return {Object|null} Instance of adapter or null if not found
     */
    public static function create($adapter, $options = array())
    {
        if (empty($adapter)) {
            return null;
        }

        // If already an instance, return it
        if (is_object($adapter)) {
            return $adapter;
        }

        // If full class name provided and exists, instantiate
        if (is_string($adapter) && class_exists($adapter)) {
            return new $adapter($options);
        }

        // Normalize adapter string to a class suffix:
        // e.g. "openai" => "Openai" => "AI_Transcription_Openai" ; "open-ai" or "open_ai" => "OpenAi"
        $sanitized = preg_replace('/[^a-z0-9]+/i', ' ', (string)$adapter);
        $suffix = str_replace(' ', '', ucfirst($sanitized));

        // Common naming convention: AI_Transcription_<Adapter>
        $className = "AI_Transcription_{$suffix}";

        if (class_exists($className)) {
            return new $className($options);
        }

        // Not found — rely on autoloader to load file by convention if needed,
        // otherwise return null so caller can handle.
        return null;
    }

    public $platform = null;
}