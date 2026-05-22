<?php

function AI_description_response_data()
{
	Q_Request::requireFields(array('subject'), true);
	$subject = $_REQUEST['subject'];

	// check quota
	$asUserId = Users::loggedInUser(true)->id;
	$roles = Users::roles();
	$quota = Users_Quota::check(
		$asUserId,
		'',
		"Streams/description",
		true,
		1,
		$roles
	);

	$communityId = Users::communityId();
	$normalizedSubject = Q_Utils::normalize($subject);
	$name = "Streams/description/$normalizedSubject";

	// Return cached description if it already exists
	$stream = Streams_Stream::fetch($communityId, $communityId, $name);
	if ($stream) {
		return $stream->content;
	}

	$LLM = new AI_LLM_Openai();

	$prompt =
		"You are describing a specific item, object, or concept.\n\n" .
		"Write a single clear paragraph that describes the following subject " .
		"to a general audience.\n\n" .
		"Subject:\n" .
		$subject;

	$response = $LLM->executeModel(
		$prompt,
		array(
			'text' => $subject
		),
		array(
			'temperature' => 0.7,
			'max_tokens'  => 300
		)
	);

	// Safety: this endpoint is sync-only
	if (is_int($response)) {
		throw new Q_Exception(
			"AI_description_response_data() cannot run in batch / async mode"
		);
	}

	$quota->used();

	$content = trim((string)$response);
	$title = "Description of $subject";

	Streams::create(
		$communityId,
		$communityId,
		'Streams/text',
		compact('name', 'title', 'content')
	);

	return $content;
}
