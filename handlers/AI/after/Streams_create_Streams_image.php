<?php
	
function AI_after_Streams_create_Streams_image($params)
{
	$stream = $params['stream'];

	$defaultTitle = Streams_Stream::getConfigField($stream->type, array('defaults', 'title'), null);
	if ($stream->title === $defaultTitle) {
		
	}

	// if (Q::startsWith($stream->name, 'Streams/image/invite/')) {
	// 	$parts = explode('/', $stream->name);
	// 	$token = end($parts);
	// 	Q::event('AI/estimateFaces/response/invitation', compact('token'));
	// }
}