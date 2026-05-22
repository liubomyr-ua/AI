<?php

function AI_discourse_post()
{
	// check authorization
	$authorized = Q_Config::get('Users', 'discourse', 'requireAuthorizedRole', false);
	if ($authorized && !Users::roles(null, $authorized)) {
		throw new Users_Exception_NotAuthorized();
	}

	Q_Request::requireFields(array('userId', 'apiKey', 'topicUrl', 'attitude'), true);
	$userId   = $_REQUEST['userId'];
	$topicUrl = $_REQUEST['topicUrl'];
	$apiKey   = $_REQUEST['apiKey'];
	$attitude = $_REQUEST['attitude'];

	// language preference
	if ($language = Q::ifset($_REQUEST, 'language', '')) {
		$info         = Q_Text::languagesInfo();
		$languageName = Q::ifset($info, $language, 'name', 'en');
	} else {
		$languageName = '';
	}

	// normalize URL
	$parts    = explode('?', $topicUrl);
	$topicUrl = reset($parts);
	if (!preg_match('/(.*)(\/t\/)(.*)/', $topicUrl, $matches)) {
		throw new Q_Exception_WrongType(array(
			'field' => 'topicUrl',
			'type'  => 'a valid Discourse topic URL'
		));
	}
	$baseUrl = $matches[1];
	$tail    = $matches[3];

	// extract topic id and post number
	if (preg_match('/(.*)\/(.*)\/(.*)/', $tail, $matches)) {
		$topicId           = $matches[1];
		$replyToPostNumber = intval($matches[3]);
	} else {
		$topicId           = $tail;
		$replyToPostNumber = 1;
	}

	// ensure user exists
	Q::event('Users/discourse/post', compact('apiKey', 'userId', 'baseUrl'));

	// get topic contents
	$uxt = new Users_ExternalTo_Discourse(array(
		'userId'   => $userId,
		'platform' => 'discourse',
		'appId'    => $baseUrl
	));
	$uxt->retrieve();
	$uxt->setExtra(compact('baseUrl', 'apiKey'));

	$ret   = $uxt->getTopic($topicUrl);
	$posts = Q::ifset($ret, 'post_stream', 'posts', array());

	// find the post matching post_number
	$target = null;
	foreach ($posts as $p) {
		if (isset($p['post_number']) && $p['post_number'] == $replyToPostNumber) {
			$target = $p;
			break;
		}
	}
	if (!$target) {
		throw new Q_Exception_MissingField(array(
			'field' => "post_number $replyToPostNumber",
			'type'  => 'Discourse post'
		));
	}

	// convert HTML to simple markdown
	$rawHtml = $target['cooked'];
	$input   = Q_Html::toSimpleMarkdown($rawHtml, 1000);

	$topicTitle = $ret['title'];
	$username   = $uxt->getExtra('username');

	$postOrComment = ($replyToPostNumber > 1) ? 'comment' : 'post';
	$byAuthor      = isset($target['name']) ? ' by ' . $target['name'] : '';

	$languageClause = $languageName
		? "Speak using $languageName language."
		: "Speak in the same language as the $postOrComment.";

	// prompt templates
	$instructions = array(
		'agree + actionable' =>
			"What follows is a $postOrComment$byAuthor.\n\n" .
			"Write one or two paragraphs expressing agreement (without saying 'I agree'), " .
			"and add actionable insights or ideas to help accomplish what is discussed.\n\n" .
			"$languageClause\n\n$postOrComment:\n$input",

		'agree + emotive' =>
			"What follows is a $postOrComment$byAuthor.\n\n" .
			"Write one enthusiastic paragraph expressing agreement and emotion.\n\n" .
			"$languageClause\n\n$postOrComment:\n$input",

		'agree + expand' =>
			"What follows is a $postOrComment$byAuthor.\n\n" .
			"Write one sentence expressing general agreement (avoid 'I agree'), " .
			"then expand into two paragraphs describing a broader, more important vision.\n\n" .
			"$languageClause\n\n$postOrComment:\n$input",

		'agree + changeSubject' =>
			"What follows is a $postOrComment$byAuthor.\n\n" .
			"Write one sentence expressing general agreement, then pivot to a related but " .
			"more important issue and explain why it matters more.\n\n" .
			"$languageClause\n\n$postOrComment:\n$input",

		'disagree + respectful' =>
			"What follows is a $postOrComment$byAuthor.\n\n" .
			"Write two sentences respectfully explaining the strongest reasons to disagree.\n\n" .
			"$languageClause\n\n$postOrComment:\n$input",

		'disagree + emotive' =>
			"What follows is a $postOrComment$byAuthor.\n\n" .
			"Write two opinionated, emotional sentences explaining why you disagree, " .
			"using well-known aphorisms.\n\n" .
			"$languageClause\n\n$postOrComment:\n$input",

		'disagree + absurd' =>
			"What follows is a $postOrComment$byAuthor.\n\n" .
			"Write a sarcastic paragraph using analogies to show why the idea can be absurd. " .
			"Keep it informal and direct.\n\n" .
			"$languageClause\n\n$postOrComment:\n$input",

		'disagree + authority' =>
			"What follows is a $postOrComment$byAuthor.\n\n" .
			"Write a paragraph disagreeing mildly, citing other respected authorities " .
			"who also disagree and summarizing their viewpoints.\n\n" .
			"$languageClause\n\n$postOrComment:\n$input"
	);

	if (empty($instructions[$attitude])) {
		throw new Q_Exception_WrongType(array(
			'field' => 'attitude',
			'type'  => 'a valid discourse response attitude'
		));
	}

	$LLM = new AI_LLM_Openai();

	$prompt =
		"You are a forum member writing a thoughtful reply.\n\n" .
		$instructions[$attitude];

	$response = $LLM->executeModel(
		$prompt,
		array('text' => $input),
		array(
			'temperature' => 0.7,
			'max_tokens'  => 400
		)
	);

	// this endpoint is sync-only
	if (is_int($response)) {
		throw new Q_Exception(
			"AI_discourse_post() cannot run in batch / async mode"
		);
	}

	$content = trim((string)$response);

	// post back to forum
	$result    = $uxt->postOnTopic($ret['id'], $content);
	$postIndex = Q::ifset($result, 'post_number', null);
	if ($postIndex !== null) {
		$postIndex = $postIndex - 1;
	}

	// save to Streams
	$communityId  = Users::communityId();
	$categoryName = 'Streams/external/posts';

	Streams_Stream::fetchOrCreate(
		$communityId,
		$communityId,
		$categoryName,
		array('type' => 'Streams/category')
	);

	Streams::create(
		$communityId,
		$communityId,
		'Streams/external/post',
		array(
			'title'      => "By $username on $topicTitle",
			'content'    => substr($content, 0, 2000),
			'attributes' => compact(
				'topicUrl',
				'topicTitle',
				'topicId',
				'replyToPostNumber',
				'postIndex',
				'username',
				'userId'
			)
		),
		array('relate' => array(
			'publisherId' => $communityId,
			'streamName'  => $categoryName,
			'type'        => 'Streams/external/posts',
			'weight'      => time()
		))
	);

	Q_Response::setSlot('data', compact('username', 'content'));
}
