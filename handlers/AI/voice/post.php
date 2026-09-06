<?php

/**
 * AI/voice (POST)
 *
 * Mints an ephemeral OpenAI Realtime session for the Safebots wake-word ->
 * Realtime-API experiment (see AI/web/js/AI/RealtimeSafebots.js). Unlike the
 * text-model pipeline (AI/classes/AI/Pipeline.js), this deliberately does
 * NOT hand the Realtime model any rolling context -- just enough
 * instructions and a single function tool so it can turn one isolated voice
 * command into the same {action, visualizationType, visualizationData, ...}
 * shape AI._processLLMResult() already knows how to handle.
 *
 * The client fetches this once, well before any wake word is detected, so
 * the WebRTC connection is already warm by the time it's needed, and again
 * whenever the connection drops (see RealtimeSafebots's reconnect logic).
 * The ephemeral token minted here is only good for ~60s, but that only
 * bounds how long the client has to *start* the WebRTC handshake -- once
 * the connection is up, its lifetime is independent of the token.
 *
 * turn_detection is explicitly null: the client already has precise,
 * text-based wake-word start/end boundaries (AI/web/js/AI/WakeWord.js), so
 * server-side VAD would just be a second, less reliable turn-detector
 * fighting the first. The client instead gates the mic track itself and
 * explicitly commits + requests a response when the wake word ends.
 */

/**
 * Render each visualizationType's field list + example from
 * AI/config/messages.schema.json into prompt text, so the Realtime model
 * gets the same per-type field guidance the text pipeline already builds
 * from this same file (see AI/classes/AI/Prompt.js's _renderAllVizTypes) --
 * without this, "visualizationData" is just a bare, undescribed object and
 * the model freelances field names that don't match what the card tools
 * actually render (e.g. {title, description} instead of comparison's
 * {left:{label,value}, right:{label,value}, rows}).
 *
 * @param {array} $schema  Decoded messages.schema.json
 * @return {array} array($enumOfTypeNames, $renderedGuideText)
 */
function AI_voice_renderVisualizationTypes($schema)
{
	$types = Q::ifset($schema, 'visualizationTypes', array());
	$names = array();
	$lines = array();
	foreach ($types as $name => $def) {
		if ($name === '' || $name[0] === '_') continue;
		$names[] = $name;

		$lines[] = "\n### $name";
		if (!empty($def['description'])) $lines[] = $def['description'];

		$fields = Q::ifset($def, 'fields', array());
		if ($fields) {
			$lines[] = 'Fields:';
			foreach ($fields as $fname => $spec) {
				$req  = !empty($spec['required']) ? '(required)' : '(optional)';
				$type = Q::ifset($spec, 'type', 'string');
				$desc = Q::ifset($spec, 'description', '');
				$lines[] = "  $fname $req: $type -- $desc";
			}
		}
		if (isset($def['example'])) {
			$lines[] = 'Example:';
			$lines[] = '  ' . str_replace("\n", "\n  ",
				json_encode($def['example'], JSON_PRETTY_PRINT));
		}
	}
	return array($names, implode("\n", $lines));
}

function AI_voice_post()
{
	$asUserId = Users::loggedInUser(true)->id;

	$schemaPath = Q::realPath('AI/config/messages.schema.json');
	$schema = $schemaPath ? json_decode(file_get_contents($schemaPath), true) : array();
	list($vizTypeNames, $vizTypesGuide) = AI_voice_renderVisualizationTypes($schema);

	$tool = array(
		'type' => 'function',
		'name' => 'report_visualization',
		'description' => 'Report the result of the user\'s voice request as a ' .
			'structured visualization proposal. Call this exactly once per ' .
			'request -- never reply with spoken audio or plain text.',
		'parameters' => array(
			'type' => 'object',
			'properties' => array(
				'action' => array(
					'type' => 'string',
					'enum' => array('propose', 'coaching', 'ephemeral', 'none'),
					'description' => "'propose' when you have a visualization to " .
						"show, 'coaching' for a private tip only the presenter " .
						"should see, 'ephemeral' for a lightweight background " .
						"update, 'none' if the request doesn't warrant any of those."
				),
				'routing' => array(
					'type' => array('string', 'null'),
					'enum' => array('shared', 'privateOnly', null)
				),
				'visualizationType' => array(
					'type' => array('string', 'null'),
					'enum' => array_merge($vizTypeNames, array(null)),
					'description' => 'Must match one of these exactly -- see the ' .
						'per-type field guide in the instructions for the exact ' .
						'shape each one needs in visualizationData.'
				),
				'visualizationData' => array(
					'type' => array('object', 'null'),
					'description' => 'The concrete content for visualizationType. ' .
						'Its shape is STRICT and type-specific -- use exactly the ' .
						'field names shown for the chosen visualizationType in the ' .
						'per-type field guide in the instructions (e.g. comparison ' .
						'needs {left:{label,value}, right:{label,value}, rows?} -- ' .
						'NOT {title, description}). Do not invent field names.'
				),
				'ephemeralType'    => array('type' => array('string', 'null')),
				'ephemeralPayload' => array('type' => array('object', 'null')),
				'coachingText'     => array('type' => array('string', 'null')),
				'sourceUri'        => array('type' => array('string', 'null')),
				'confidence'       => array('type' => 'number', 'description' => '0 to 1')
			),
			'required' => array('action', 'confidence')
		)
	);

	$instructions =
		"You are Safebots, a voice assistant embedded in a live presentation.\n" .
		"The audio you receive is a single, already-isolated voice command -- " .
		"the wake phrase ('Hey Safebots' / 'Safebots') has already been " .
		"detected and stripped out client-side, so treat everything you hear " .
		"as one complete request. You have no earlier conversation history.\n" .
		"When the speaker finishes, call report_visualization exactly once " .
		"with your answer. Never reply with spoken audio or plain text -- " .
		"report_visualization is the only acceptable response.\n\n" .
		"When action is 'propose', visualizationData's shape depends STRICTLY " .
		"on visualizationType -- use exactly the field names below, never " .
		"invent your own (e.g. comparison is {left,right,rows?}, NOT " .
		"{title,description}):\n" .
		$vizTypesGuide;

	$broker = AI_Voice::route('conversational', array(
		'instructions'    => $instructions,
		'tools'           => array($tool),
		'tool_choice'     => array('type' => 'function', 'name' => 'report_visualization'),
		'turn_detection'  => null, // manual mode -- see file doc comment above
		'modalities'      => array('text'), // no spoken reply needed, only the function call
		'input_audio_transcription' => array('model' => 'gpt-4o-mini-transcribe'),
		// Real-world facts (current events, statistics, etc.) need an actual
		// lookup -- OpenAI's Realtime API has no web-search capability at
		// all (confirmed via OpenAI's own support forum), so AI_Voice_Openai
		// just ignores this key. AI_Voice_Gemini adds the googleSearch tool,
		// which Gemini Live DOES support alongside custom function calling.
		'webSearch'       => true
	));
	if (!$broker) {
		throw new Q_Exception("AI/voice: no Realtime voice provider configured");
	}

	$session = $broker->createSession();

	Q_Response::setSlot('data', $session);
}
