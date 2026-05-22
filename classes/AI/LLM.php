<?php
/**
 * Base interfaces and abstractions for Large Language Model (LLM) adapters.
 *
 * This file defines a **provider-agnostic execution contract** that cleanly
 * supports OpenAI (Responses API), Google Gemini, and AWS Bedrock / Anthropic Claude
 * without leaking provider-specific semantics into application code.
 *
 * Core design principles:
 *
 * 1. executeModel() is the ONLY primitive.
 * 2. Exactly ONE RPC is performed per call.
 * 3. No retries, batching, streaming, orchestration, or policy logic here.
 *
 * This layer represents a **pure model execution boundary**.
 *
 * Higher-level orchestration (workflows, tool execution, retries,
 * policy enforcement, etc.) must occur outside this interface.
 *
 * Conversation semantics
 * ----------------------
 *
 * Modern LLM APIs operate on an **ordered timeline of messages**.
 *
 * Messages must be interpreted **chronologically**. Ordering is critical.
 *
 * Logical hierarchy used by most models:
 *
 * system / developer instructions
 * ↓
 * tool outputs
 * ↓
 * assistant messages
 * ↓
 * user messages
 *
 * When conflicts occur, higher levels override lower levels.
 *
 * Providers map this hierarchy differently:
 *
 * OpenAI Responses API
 *   system → instructions
 *   user → input role=user
 *   assistant → role=assistant
 *   tool outputs → role=tool
 *
 * Anthropic Claude
 *   system → system
 *   user → role=user
 *   assistant → role=assistant
 *   tool outputs → type=tool_result
 *
 * Google Gemini
 *   system → system_instruction
 *   user → role=user
 *   assistant → role=model
 *   tool outputs → tool parts
 *
 * This interface abstracts those differences.
 */

/**
 * Interface AI_LLM_Interface
 *
 * Provider adapters MUST implement this interface.
 */
interface AI_LLM_Interface
{
	/**
	 * Execute a single model invocation.
	 *
	 * This performs **exactly one RPC** to the underlying model provider.
	 *
	 * Adapters MUST NOT:
	 * - retry requests
	 * - batch requests
	 * - orchestrate tools
	 * - manage conversations
	 *
	 * Those behaviors belong to higher layers.
	 *
	 * @method executeModel
	 *
	 * @param {string} $instructions
	 *   System / developer instructions.
	 *
	 *   This text defines the **rules, constraints, schemas, and task framing**
	 *   that govern the model's behavior.
	 *
	 *   Examples:
	 *   - task definitions
	 *   - JSON schema instructions
	 *   - output format rules
	 *   - safety constraints
	 *
	 *   Provider mappings:
	 *
	 *   OpenAI → instructions
	 *   Claude → system
	 *   Gemini → system_instruction
	 *
	 * @param {array} $inputs
	 *   Multimodal artifacts supplied to the model.
	 *
	 *   These represent **binary or external artifacts** rather than
	 *   conversational messages.
	 *
	 *   Canonical structure:
	 *
	 *   {
	 *     images: array<binary>,
	 *       Raw binary image data (PNG/JPEG).
	 *
	 *     pdfs: array<binary>,
	 *       Optional document binaries.
	 *
	 *     audio: array<binary>,
	 *       Future-facing speech/audio input.
	 *
	 *     video: array<binary>,
	 *       Future-facing video input.
	 *
	 *     artifacts: array<mixed>
	 *       Arbitrary external artifacts such as:
	 *       - embeddings
	 *       - structured metadata
	 *       - pipeline outputs
	 *   }
	 *
	 * @param {array} $options
	 *   Execution and conversation configuration.
	 *
	 *   Conversation timeline
	 *   ---------------------
	 *
	 *   messages: array|null
	 *
	 *   Ordered message list representing the conversation.
	 *
	 *   Canonical structure:
	 *
	 *   [
	 *     { role: "user", content: string|array },
	 *     { role: "assistant", content: string|array },
	 *     { role: "tool", name: string, content: mixed }
	 *   ]
	 *
	 *   Content may be:
	 *
	 *   - plain text
	 *   - multimodal blocks
	 *   - structured tool outputs
	 *
	 *   Adapters must translate this structure into the provider's format.
	 *
	 *   Legacy compatibility fields
	 *   ---------------------------
	 *
	 *   These MAY still appear for backwards compatibility but SHOULD NOT
	 *   be used by new code. Adapters may convert them into `messages`.
	 *
	 *   user: string
	 *   assistant: string|array
	 *   context: string|array
	 *   tool_results: array
	 *
	 *   Execution parameters
	 *   --------------------
	 *
	 *   model: string
	 *     Provider model name.
	 *
	 *   temperature: number
	 *     Sampling temperature.
	 *
	 *   max_tokens: number
	 *     Maximum output tokens.
	 *
	 *   response_format: string
	 *     "json" or "json_schema".
	 *
	 *   json_schema: object
	 *     JSON schema definition when response_format = json_schema.
	 *
	 *   timeout: number
	 *     Network timeout seconds.
	 *
	 *   callback: callable
	 *     Optional async callback handler.
	 *
	 * @return {string|integer}
	 *   Sync mode → model output text.
	 *
	 *   Async / batch mode → integer request index.
	 */
	function executeModel($instructions, array $inputs, array $options = array());
}

/**
 * Abstract base class AI_LLM
 *
 * Provides common helper behavior shared across adapters.
 */
abstract class AI_LLM implements AI_LLM_Interface
{
	/**
	 * Execute a single model invocation.
	 *
	 * Concrete adapters MUST implement this.
	 *
	 * @method executeModel
	 * @abstract
	 */
	abstract public function executeModel($instructions, array $inputs, array $options = array());

    /**
	 * Process multimodal inputs through observation evaluation.
	 *
	 * Exactly ONE model call is made.
	 * The model produces ONLY per-artifact observations.
	 *
	 * @method process
	 * @param {array} $inputs
	 *   Arbitrary multimodal inputs. Examples:
	 *   {
	 *     text: string,
	 *     images: array<binary>,
	 *     pdfs: array<binary>,
	 *     artifacts: array<mixed>
	 *   }
	 * @param {array} $observations
	 *   observationName => {
	 *     promptClause: string,
	 *     fieldNames: array<string>,
	 *     example?: array<string,mixed>
	 *   }
	 * @param {array} [$interpolate]
	 *   Optional placeholder map passed to Q::interpolate()
     * @param {array} [$options]
	 *   Options to pass to executeModel method
	 * @return {array}
	 *   Observation JSON emitted by the model, or empty array if no observations passed.
	 * @throws {Q_Exception}
	 */
	function process(array $inputs, array $observations, array $interpolate = array(), array $options = array())
	{
		if (empty($observations)) {
			return array();
		}

		$o = self::promptFromObservations($observations);

		if (empty($o['clauses'])) {
			throw new Exception("No valid observation clauses generated");
		}

		$prompt =
			"You are an automated semantic processor.\n\n" .
			"Rules:\n" .
			"- Output MUST be valid JSON\n" .
			"- Do not include comments or prose\n" .
			"- Do not omit fields\n" .
			"- Use null when uncertain\n" .
			"- Arrays must respect stated limits\n" .
			"- Numeric values must be within stated ranges\n" .
			"- If uncertainty is high for any field, lower the confidence score accordingly\n\n" .
			"Inputs are referenced ONLY by the names provided in the text.\n" .
			"Do not infer meaning from order, index, or file type.\n\n" .
			"OBSERVATIONS:\n" . implode("\n", $o['clauses']) . "\n\n" .
			"Return ONLY valid JSON matching this schema exactly:\n" .
			json_encode($o['schema'], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);

		if (!empty($interpolate)) {
			$prompt = Q::interpolate($prompt, $interpolate);
		}

		return $this->_executeWithCallback($prompt, $inputs, $options, function ($raw) {
            $data = json_decode($raw, true);
            if (!is_array($data)) {
                throw new Q_Exception("Model did not return valid JSON");
            }
            return $data;
        });
	}


    /**
     * Create an LLM adapter instance from a string or return an existing instance.
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
        // e.g. "openai" => "Openai" => "AI_LLM_Openai" ; "open-ai" or "open_ai" => "OpenAi"
        $sanitized = preg_replace('/[^a-z0-9]+/i', ' ', (string)$adapter);
        $suffix = str_replace(' ', '', ucwords($sanitized));

        // Common naming convention: AI_LLM_<Adapter>
        $className = "AI_LLM_{$suffix}";

        if (class_exists($className)) {
            return new $className($options);
        }

        // Try alternative: prefix without underscore (legacy variations)
        $altClass = "AI_LLM_" . $suffix;
        if (class_exists($altClass)) {
            return new $altClass($options);
        }

        // Not found — rely on autoloader to load file by convention if needed,
        // otherwise return null so caller can handle.
        return null;
    }

    /**
     * Route to an LLM adapter by deployment-configured route name.
     *
     * Deployments configure an "AI/llm/routes" map (route name -> provider name)
     * and "AI/llm/providers" map (provider name -> { class, config }).
     * This method resolves a route name to an adapter instance.
     *
     * Example config:
     *   AI: {
     *     llm: {
     *       default: "anthropic-direct",
     *       providers: {
     *         "anthropic-direct": { class: "Anthropic", config: {...} },
     *         "anthropic-bedrock": { class: "Aws", config: {...} },
     *         "anthropic-vertex": { class: "VertexAi", config: {...} },
     *         "openai-direct": { class: "Openai", config: {...} },
     *         "openai-azure": { class: "AzureOpenai", config: {...} },
     *         "llama-local-vllm": { class: "Local", config: { subtype: "vllm", ... } }
     *       },
     *       routes: {
     *         smart: "anthropic-direct",
     *         "smart-cached": "llama-local-vllm",
     *         fast: "openai-direct",
     *         vision: "anthropic-direct"
     *       }
     *     }
     *   }
     *
     * Usage:
     *   $llm = AI_LLM::route('smart');
     *   $llm = AI_LLM::route('smart-cached');  // returns an Advanced-capable instance
     *
     * Unknown route falls back to AI/llm/default. If that's also missing,
     * falls back to the first provider in AI/llm/providers. If even that
     * is missing, returns null.
     *
     * @method route
     * @static
     * @param {string} $routeName  Route name e.g. 'smart', 'fast', 'vision', 'smart-cached'
     * @param {array}  [$options]  Additional options forwarded to the adapter constructor
     * @return {AI_LLM|null}       Adapter instance, or null if no provider resolves
     */
    public static function route($routeName, array $options = array())
    {
        $routes    = Q_Config::get(array('AI', 'llm', 'routes'), array());
        $providers = Q_Config::get(array('AI', 'llm', 'providers'), array());
        $default   = Q_Config::get(array('AI', 'llm', 'default'), null);

        // 1. Resolve route name to provider name.
        $providerName = null;
        if (is_array($routes) && isset($routes[$routeName])) {
            $providerName = $routes[$routeName];
        } elseif ($default) {
            $providerName = $default;
        } elseif (is_array($providers) && !empty($providers)) {
            $names = array_keys($providers);
            $providerName = reset($names);
        }
        if (!$providerName) {
            return null;
        }

        // 2. Resolve provider name to class + config.
        $providerDef = null;
        if (is_array($providers) && isset($providers[$providerName])) {
            $providerDef = $providers[$providerName];
        } else {
            // No provider definition — treat providerName as a direct adapter class.
            return self::create($providerName, $options);
        }

        $className = isset($providerDef['class']) ? $providerDef['class'] : null;
        if (!$className) {
            return null;
        }

        // 3. Merge provider config with caller options. Caller options win.
        $mergedOptions = array();
        if (isset($providerDef['config']) && is_array($providerDef['config'])) {
            $mergedOptions = $providerDef['config'];
        }
        $mergedOptions = array_replace($mergedOptions, $options);

        // 4. Instantiate.
        return self::create($className, $mergedOptions);
    }

    /**
     * List all configured route names.
     *
     * @method listRoutes
     * @static
     * @return {array}  array of route names
     */
    public static function listRoutes()
    {
        $routes = Q_Config::get(array('AI', 'llm', 'routes'), array());
        return is_array($routes) ? array_keys($routes) : array();
    }

    /**
     * List all configured provider names.
     *
     * @method listProviders
     * @static
     * @return {array}  array of provider names
     */
    public static function listProviders()
    {
        $providers = Q_Config::get(array('AI', 'llm', 'providers'), array());
        return is_array($providers) ? array_keys($providers) : array();
    }


	/**
	 * Build prompt clauses and JSON schema from observation definitions.
	 *
	 * Observations are local, per-artifact evaluators.
	 *
	 * @method promptFromObservations
	 * @static
	 * @protected
	 * @param {array} $observations
	 *   observationName => {
	 *     promptClause: string,
	 *     fieldNames: array<string>,
	 *     example?: array<string,mixed>
	 *   }
	 * @return {array}
	 *   {
	 *     clauses: array<string>,
	 *     schema: object
	 *   }
	 */
	static function promptFromObservations(array $observations)
	{
		$clauses = array();
		$schema  = array();

		foreach ($observations as $name => $o) {
			if (empty($o['promptClause']) || empty($o['fieldNames'])) {
				continue;
			}

			$clauses[] = "- {$o['promptClause']}";

			if (!isset($schema[$name])) {
				$schema[$name] = array();
			}

			foreach ($o['fieldNames'] as $field) {
				if (isset($o['example']) && array_key_exists($field, $o['example'])) {
					$schema[$name][$field] = $o['example'][$field];
				} else {
					$schema[$name][$field] = null;
				}
			}
		}

		return array(
			'clauses' => $clauses,
			'schema'  => $schema
		);
	}

    /**
     * Can be used to summarize the text, generate keywords for searching, and find out who's speaking.
     * @method summarize
     * @param {string} $text the text to summarize, should fit into the LLM's context window
     * @param {array} [$options=array()] see options of chatCompletions
     * @param {array} [$options.temperature=0] sets 0 temperature for summaries by default
     * @return {array} An array with keys "summary", "keywords" and "speakers"
     */
    function summarize($text, $options = array())
    {
        if (!isset($options['temperature'])) {
            $options['temperature'] = 0;
        }
        if (!isset($options['max_tokens'])) {
            $options['max_tokens'] = 1000;
        }

        if (!trim($text)) {
            return array();
        }

        $instructions = <<<HEREDOC
    You are a language model tasked with extracting structured summaries for indexing, using clearly labeled XML-style tags.

    Output exactly these sections:
    <title> (under 200 characters)
    <keywords> one line, max 400 characters
    <summary> one paragraph, max 512 characters
    <speakers> comma-separated names OR "no names"

    Rules:
    - No extra text
    - No markdown
    - No explanations

    Text to process:
    $text
HEREDOC;

        return $this->_executeWithCallback($instructions, compact('text'), $options, function ($raw) {
            $content = is_array($raw)
                ? json_encode($raw)
                : (string)$raw;

            $content = trim(preg_replace('/^```.*?\n|\n```$/s', '', $content));

            preg_match('/<title>(.*?)<\/title>/s', $content, $t);
            preg_match('/<keywords>(.*?)<\/keywords>/s', $content, $k);
            preg_match('/<summary>(.*?)<\/summary>/s', $content, $s);
            preg_match('/<speakers>(.*?)<\/speakers>/s', $content, $sp);

            $title = trim(isset($t[1]) ? $t[1] : '');
            $summary = trim(isset($s[1]) ? $s[1] : '');
            $speakers = trim(isset($sp[1]) ? $sp[1] : '');
            $keywordsString = trim(isset($k[1]) ? $k[1] : '');

            $keywords = $keywordsString !== ''
                ? preg_split('/\s*,\s*/', $keywordsString)
                : array();

            if (strtolower($speakers) === 'no names') {
                $speakers = '';
            }

            return compact('title', 'keywords', 'summary', 'speakers');
        });
    }

	/**
	 * Expand a list of canonical keywords into related terms for search indexing.
	 * 
	 * This method sends the given keywords to the language model and requests
	 * expansion into related search terms. It is intended to be used both
	 * during content insertion and during query processing.
	 * 
	 * When used during insert time, the model is encouraged to expand the keywords
	 * broadly and include synonyms, alternate phrasings, and variations.
	 * 
	 * When used during query time, the expansion is narrower and more literal,
	 * intended to match only closely relevant synonyms or rephrasings that improve recall.
	 *
	 * If $options['language'] is provided and is not "en", the model is asked
	 * to additionally return native-language keywords in a second line.
	 *
	 * @method keywords
	 * @param {array} $keywords An array of 1-word or 2-word canonical keyword strings.
	 * @param {string} $during Either 'insert' or 'query' to control expansion depth.
	 * @param {array} [$options=array()] Optional LLM options like model, temperature, language.
	 * @param {array|null} [&$keywordsNative=null] Filled with native-language keywords if language != "en"
	 * @return {array} An array of expanded keyword terms (strings), deduplicated and lowercased.
	 */
	function keywords(array $keywords, $during = 'insert', $options = array(), &$keywordsNative = null)
	{
		if (empty($keywords)) {
			if (func_num_args() >= 4) {
				$keywordsNative = array();
			}
			return array();
		}

		$original = implode(', ', $keywords);
		$temperature = ($during === 'query') ? 0.3 : 0.7;
		$language = Q::ifset($options, 'language', 'en');

		$prompt = <<<HEREDOC
	Expand the following canonical search keywords into useful query terms.

	Input:
	$original

	Rules:
	- Output lines exactly as specified below
	- Comma-separated
	- Max 1000 terms per line
	- Each term must be 1 or 2 words
	- No punctuation other than commas
	- No duplicates
	- No sentences
	- Highly relevant only

	Output:
	Line 1: English keywords

	HEREDOC;

		if ($language && strtolower($language) !== 'en') {
			$prompt .= <<<HEREDOC
	Line 2: {$language} keywords (native language only)
	HEREDOC;
		}

		return $this->_executeWithCallback($prompt, array(
			'text' => $original
		), array_merge(
			array(
				'temperature' => $temperature,
				'max_tokens' => 2000
			),
			$options
		), function ($raw) use (&$keywordsNative, $language) {

			$content = is_array($raw)
				? json_encode($raw)
				: (string)$raw;

			$content = trim(preg_replace('/^```.*?\n|\n```$/s', '', $content));

			$lines = preg_split('/\r?\n/', trim($content));
			$englishLine = isset($lines[0]) ? $lines[0] : '';
			$nativeLine = isset($lines[1]) ? $lines[1] : '';

			$english = array_values(array_unique(array_filter(array_map(
				'strtolower',
				preg_split('/\s*,\s*/', $englishLine)
			))));

			if ($language && strtolower($language) !== 'en' && func_num_args() >= 4) {
				$keywordsNative = array_values(array_unique(array_filter(array_map(
					'mb_strtolower',
					preg_split('/\s*,\s*/', $nativeLine)
				))));
			} else if (func_num_args() >= 4) {
				$keywordsNative = array();
			}

			return $english;
		});
	}

    /**
	 * Use this function to merge all the files under AI/observations config,
	 * and get info for all potential observations, indexed by their name.
	 *
	 * After loading all configs, each top-level entry is interpolated using
	 * Q::interpolate($value, $rootArray).
	 *
	 * @method userStreamsTree
	 * @static
	 */
	static function observationsTree()
	{
		static $p = null;
		static $previousArr = null;

		$arr = Q_Config::get('AI', 'observations', array());
		if ($p && $previousArr === $arr) {
			return $p;
		}
		$previousArr = $arr;

		$p = new Q_Tree();
		$app = Q::app();

		foreach ($arr as $k => $v) {
			$PREFIX = ($k === $app ? 'APP' : strtoupper($k).'_PLUGIN');
			$path = constant($PREFIX . '_CONFIG_DIR');
			$p->load($path . DS . $v);
		}

		// Interpolate each top-level entry
		$communityId = Users::communityId();
		$currentCommunityId = Users::currentCommunityId();
        $currentYear = date("Y");
		$loggedInUser = Users::loggedInUser();
		$loggedInUserId = $loggedInUser ? $loggedInUser->id : null;
		$vars = compact(
			'communityId', 'currentCommunityId', 'loggedInUserId', 'currentYear'
		);
		$all = $p->getAll();
		$interp = array();
		foreach ($all as $key => $value) {
			$newKey = Q::interpolate($key, $vars);
			if ($newKey !== $key) {
				$p->clear($key);
				$interp[$newKey] = $value;
			}
		}
		foreach ($interp as $k => $v) {
			$p->set($k, $v);
		}
		return $p;
    }

    /**
     * Helper method to load all observation definitions from config,
     * for a given type of input.
     * @method observations
     * @static
     * @param {string} $streamType
     * @param {string} $observationsType for that stream type
     * @return {array}
     */
    static function observations($streamType, $observationsType)
    {
        return self::observationsTree()->get($streamType, $observationsType, array());
    }

    /**
     * Gather deterministic stream attributes from data
     * constrained strictly by observation fieldNames.
     *
     * @method fieldNames
     * @static
     * @param {string} [$streamType] e.g. "Streams/images"
     * @param {string} [$observationsType] e.g. "holiday" for that stream type
     * @param {array} [$results] data with the results to gather from
     * @return {array}
     */
    static function fieldNames($streamType, $observationsType, array $results)
    {
        $attr = array();

        // Load observation definitions
        $observations = self::observations($streamType, $observationsType);
        if (empty($observations)) {
            return $attr;
        }

        // Collect allowed fieldNames
        $allowed = array();
        foreach ($observations as $obs) {
            if (empty($obs['fieldNames']) || !is_array($obs['fieldNames'])) {
                continue;
            }
            foreach ($obs['fieldNames'] as $field) {
                $allowed[$field] = true;
            }
        }

        // Filter + normalize
        foreach ($allowed as $field => $stuff) {

            if (!array_key_exists($field, $results)) {
                continue;
            }

            $value = $results[$field];

            // Strings: trim + drop empty
            if (is_string($value)) {
                $value = trim($value);
                if ($value === '') continue;
            }

            // Arrays: compact + reindex
            if (is_array($value)) {
                $value = array_values(array_filter($value, function ($v) {
                    return $v !== null && $v !== '';
                }));
                if (empty($value)) continue;
            }

            // Scalars: pass through
            $attr[$field] = $value;
        }

        return $attr;
    }

    /**
     * Run observations and optionally create a stream.
     *
     * @method createStream
     * @param {string} $streamType 
     * @param {string} Observation type (e.g. "images/holiday")
     * @param {array} $stream Stream creation data (publisherId, type, title?, icon?)
     * @param {array} [$results] Deterministic results of a model call
     * @param {array} [$options] Behavior overrides
     * @param {string} [$options.adapter] LLM adapter name
     * @param {callable|true} [$options.accept] Acceptance callback, set to true to always accept
     * @return {Streams_Stream|false} Created stream or false if stream failed policy gate
     */
	static function createStream(
		$streamType,
        $observationsType,
		array $stream,
		array $results = array(),
		array $options = array()
	) {
		// 1) Deterministic attributes
		$attributes = self::fieldNames($streamType, $observationsType, $results);

        $accept = Q::ifset($options, 'accept', array('AI_LLM', 'accept'));
        if ($accept && $accept !== true && !call_user_func($accept, $attributes)) {
            return false;
        }

		// 3) Create stream
		$title = Q::ifset($stream, 'title', null);
		if ($title === null && isset($attributes['title'])) {
			$title = $attributes['title'];
			unset($attributes['title']);
		}

        while (!empty($attributes['keywords'])
        and 1000 < strlen(Q::json_encode($attributes, Q::JSON_FORCE_OBJECT))) {
            $attributes['keywords'] = array_slice($attributes['keywords'], 0, -1);
            $attributes['keywordsNative'] = array_slice($attributes['keywordsNative'], 0, -1);
        }

        $publisherId = Q::ifset($options, 'publisherId', Q::app());
		return Streams::create(
			'AI',
			$publisherId,
			$streamType,
			array(
				'title' => $title,
				'icon' => Q::ifset($stream, 'icon', null),
				'attributes' => $attributes
			),
			array(
				'skipAccess' => true
			)
		);
	}


	/**
	 * Hard policy gate. Rejects before attributes are even written.
	 * @method accept
	 * @static
	 * @param {array} $attributes
	 * @return {boolean} 
	 */
	static function accept($attributes)
	{
		if (Q::ifset($attributes, 'obscene', 10) > 3
		 || Q::ifset($attributes, 'controversial', 10) > 5
		 || Q::ifset($attributes, 'confidence', 0) < 0.6) {
			return false;
		}

		return true;
	}

	/**
	 * Extract a compact, attribute-safe, FLAT attribute set
	 * from LLM observation results.
	 *
	 * Output shape matches Streams_Stream::syncRelations expectations.
	 *
	 * @method attributesFromObservationResults
	 * @static
	 * @param {array} $observations Full LLM output (keyed by observation section)
     * @param {string} [$streamType="Streams/image"]
	 * @param {string} [$observationsType="holiday"]
	 * @return {array} flat array of attributes
	 */
	static function attributesFromObservationResults(array $observations, $streamType = 'Streams/image', $observationsType = 'holiday')
	{
		$out = array();

		// Load observation definitions
		$defs = AI_LLM::observations($streamType, $observationsType);
		if (empty($defs)) {
			return $out;
		}

		// Collect allowed fieldNames
		$allowed = array();
		foreach ($defs as $def) {
			if (empty($def['fieldNames']) || !is_array($def['fieldNames'])) {
				continue;
			}
			foreach ($def['fieldNames'] as $field) {
				$allowed[$field] = true;
			}
		}

		// Flatten observations
		foreach ($observations as $section => $values) {

			if (!is_array($values)) {
				continue;
			}

			foreach ($values as $field => $value) {

				// Strict allowlist
				if (empty($allowed[$field])) {
					continue;
				}

				// Normalize strings
				if (is_string($value)) {
					$value = trim($value);
					if ($value === '') continue;

					// Truncate short semantic text
					if ($field === 'title' || $field === 'subtitle') {
						$value = mb_substr($value, 0, 100);
					}
				}

				// Normalize arrays
				if (is_array($value)) {
					$value = array_values(array_filter($value, function ($v) {
						return $v !== null && $v !== '';
					}));
					if (!$value) continue;

					// Hard bounds for keyword arrays
					if ($field === 'keywords' || $field === 'keywordsNative') {
						$value = array_slice($value, 0, 10);
						$value = array_map(function ($v) {
							$v = Q_Utils::normalize($v);
							return mb_substr((string)$v, 0, 32);
						}, $value);
						$value = array_values(array_filter($value, 'strlen'));
						if (!$value) continue;
					}
				}

				// Scalars: pass through
				if ($value === null) {
					continue;
				}

				$out[$field] = $value;
			}
		}

		return $out;
	}

    protected function _executeWithCallback($prompt, array $inputs, array $options, $parser)
    {
        $callback = Q::ifset($options, 'callback', null);

        $response = $this->executeModel(
            $prompt,
            $inputs,
            array_merge($options, array(
                'callback' => function ($result) use ($parser, $callback) {
                    if (is_array($result) && isset($result['text'])) {
                        $raw = $result['text'];
                    } else {
                        $raw = $result;
                    }
                    $parsed = call_user_func($parser, $raw);
                    if ($callback && is_callable($callback)) {
                        call_user_func($callback, $parsed);
                    }
                }
            ))
        );

        if (is_int($response)) {
            return $response;
        }

        return $response;
    }
}
