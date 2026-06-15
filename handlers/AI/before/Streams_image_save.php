<?php

function AI_before_Streams_image_save($params)
{
	if (!Q_Config::get('AI', 'images', 'titles', 'generate', false)) {
		return;
	}

	$stream = Q::ifset($params, 'stream', null);
	if (!$stream instanceof Streams_Stream) {
		return;
	}

	$types = Q_Config::get('AI', 'images', 'titles', 'types', array('Streams/image'));
	if (!in_array($stream->type, $types, true)) {
		return;
	}

	// Fill whichever is missing — title and content are independent.
	$defaultTitle  = Streams_Stream::getConfigField($stream->type, array('defaults', 'title'), null);
	$currentTitle  = (string)$stream->title;
	$titleNeeded   = ($currentTitle === '' || $currentTitle === (string)$defaultTitle);
	$contentNeeded = (trim((string)$stream->content) === '');
	if (!$titleNeeded && !$contentNeeded) {
		return; // nothing to do
	}

	// Sizes attribute is already sorted ascending by the caller.
	$sizes = $stream->getAttribute('sizes');
	if (empty($sizes) || !is_array($sizes)) {
		return;
	}
	$min  = Q_Config::get('AI', 'images', 'titles', 'minimumDimensions', '100x100');
	$size = Q_Image::largestSize($sizes, false, array('minimumDimensions' => $min));
	if (!$size) {
		return;
	}

	// Locate the file (sizes attribute is keys only, so probe extensions).
	$binary = null;
	foreach (array('png', 'jpg', 'jpeg') as $ext) {
		$file = Q_Uri::filenamefromUrl($stream->icon . "/$size.$ext");
		if ($file && is_file($file)) {
			$binary = file_get_contents($file);
			break;
		}
	}
	if (!$binary) {
		return;
	}

	$llm = AI_LLM::route(Q_Config::get('AI', 'images', 'titles', 'route', 'vision'));
	if (!$llm) {
		return;
	}

	$maxContent = (int)Q_Config::get('AI', 'images', 'titles', 'maxContentLength', 200);

	$instructions =
		"Describe an image with a short title and a brief description.\n" .
		"Return ONLY a JSON object and nothing else — no markdown, no code fences:\n" .
		'{"title": "...", "content": "..."}' . "\n" .
		"Rules:\n" .
		"- title: at most 3 words naming the concrete main subject; no quotes, no trailing punctuation\n" .
		"- content: one or two plain sentences describing what is visible, at most {$maxContent} characters\n" .
		"- Base it only on what is actually visible; the image may be small or blurry — give your most likely reading\n" .
		"- No commentary outside the JSON object";

	$options = array('temperature' => 0.2, 'max_tokens' => 200);
	if ($model = Q_Config::get('AI', 'images', 'titles', 'model', null)) {
		$options['model'] = $model;
	}

	try {
		$raw = (string)$llm->executeModel($instructions, array('images' => array($binary)), $options);
		$raw = trim($raw);
		$raw = preg_replace('/^```[a-z]*\s*|\s*```$/i', '', $raw); // strip stray fences

		$parsed = json_decode($raw, true);
		if (is_array($parsed)) {
			$title   = isset($parsed['title'])   ? (string)$parsed['title']   : '';
			$content = isset($parsed['content']) ? (string)$parsed['content'] : '';
		} else {
			// Fallback: first line is the title, the rest is the description.
			$lines   = preg_split('/\r?\n/', $raw, 2);
			$title   = isset($lines[0]) ? $lines[0] : '';
			$content = isset($lines[1]) ? $lines[1] : '';
		}

		// --- normalize title: 3-word cap + Initial Caps, preserving mixed case ---
		$title = trim(preg_replace('/\s+/', ' ', trim($title)));
		$title = trim($title, " \t\n\r\"'.,;:!?");
		$words = array_slice(preg_split('/\s+/', $title, -1, PREG_SPLIT_NO_EMPTY), 0, 3);
		$words = array_map(function ($w) {
			$lower = mb_strtolower($w, 'UTF-8');
			$upper = mb_strtoupper($w, 'UTF-8');
			if ($w !== $lower && $w !== $upper) {
				return $w; // already mixed case (iPhone, McDonald)
			}
			return mb_strtoupper(mb_substr($w, 0, 1, 'UTF-8'), 'UTF-8')
				. mb_strtolower(mb_substr($w, 1, null, 'UTF-8'), 'UTF-8');
		}, $words);
		$title = mb_substr(implode(' ', $words), 0, 100);

		// --- normalize content: collapse whitespace, strip wrapping quotes, cap length ---
		$content = trim(preg_replace('/\s+/', ' ', trim($content)));
		$content = trim($content, " \t\n\r\"'");
		$content = mb_substr($content, 0, $maxContent);
	} catch (Exception $e) {
		Q::log("AI image title/content generation failed: " . $e->getMessage());
		return;
	}

	// Mutate in place — the caller persists (and broadcasts via changed()).
	if ($titleNeeded && $title !== '') {
		$stream->title = $title;
	}
	if ($contentNeeded && $content !== '') {
		$stream->content = $content;
	}
}