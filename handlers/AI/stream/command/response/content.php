<?php
/**
 * AI/handlers/AI/stream/command/response/content.php
 *
 * PHP action handler for Node→PHP stream command requests.
 * Called by AI/handlers/AI/commands/streamCommand.js via Q.Utils.sendToPHP().
 *
 * Q.Utils.sendToPHP signs the payload with the internal secret;
 * Q_Utils::verifyInternal() verifies it here.
 *
 * Executes the requested stream operation as asUserId, then posts
 * the result (or exception message) to the Streams/chat backing stream.
 * The result also returns in the JSON slots so Node can use it.
 *
 * Operations:
 *   create       — Streams::create Streams/chat related to presentation stream
 *   grantAccess  — Streams_Access upsert for targetUserId on presentation stream
 *   revokeAccess — Streams_Access delete for targetUserId on presentation stream
 */
function AI_stream_command_response_content()
{
    // Verify this came from our own Node process
    if (!Q_Utils::verifyInternal()) {
        throw new Users_Exception_NotAuthorized();
    }

    $command         = Q::ifset($_POST, 'command', '');
    $asUserId        = Q::ifset($_POST, 'asUserId', '');
    $publisherId     = Q::ifset($_POST, 'publisherId', '');
    $streamName      = Q::ifset($_POST, 'streamName', '');
    $chatPublisherId = Q::ifset($_POST, 'chatPublisherId', $asUserId);
    $chatStreamName  = Q::ifset($_POST, 'chatStreamName', '');
    $targetUserId    = Q::ifset($_POST, 'targetUserId', '');
    $targetDisplay   = Q::ifset($_POST, 'targetDisplay', $targetUserId);
    $writeLevel      = Q::ifset($_POST, 'writeLevel', 'post');
    $toolTitle       = Q::ifset($_POST, 'toolTitle', 'Tool');

    if (!$asUserId || !$chatStreamName) {
        throw new Q_Exception_RequiredField(array('field' => 'asUserId or chatStreamName'));
    }

    $resultContent  = null;
    $instructions   = array();
    $messageType    = 'AI/command/result';

    try {
        switch ($command) {

            case 'create':
                // Create a Streams/chat stream published by the requesting user,
                // related to the presentation stream with inheritAccess.
                // Name: Streams/chat/{calendarId}/{timestamp} — unique per creation
                $calendarId    = basename($streamName);
                $newStreamName = 'Streams/chat/' . $calendarId . '/' . uniqid();

                $stream = Streams::create(
                    $asUserId,
                    $asUserId,
                    'Streams/chat',
                    array(
                        'title'      => $toolTitle,
                        'writeLevel' => Streams::$WRITE_LEVEL['max'],
                        'readLevel'  => Streams::$READ_LEVEL['content'],
                        'adminLevel' => Streams::$ADMIN_LEVEL['own'],
                        'name'       => $newStreamName,
                    ),
                    array(
                        'relate' => array(
                            'publisherId'   => $publisherId,
                            'streamName'    => $streamName,
                            'type'          => 'Media/presentation/tool',
                            'inheritAccess' => true,
                        ),
                    )
                );

                $resultContent = "✓ Created \"$toolTitle\". Participants can now post to it.";
                $instructions  = array(
                    'streamCreated'  => true,
                    'newPublisherId' => $asUserId,
                    'newStreamName'  => $stream->name,
                    'toolTitle'      => $toolTitle,
                );
                break;

            case 'grantAccess':
                if (!$targetUserId) {
                    throw new Q_Exception_RequiredField(array('field' => 'targetUserId'));
                }
                // Verify asUserId has manage-level admin on the presentation stream
                $stream = Streams_Stream::fetch($asUserId, $publisherId, $streamName, true);
                if (!$stream->testAdminLevel('manage')) {
                    throw new Users_Exception_NotAuthorized();
                }
                $wl = isset(Streams::$WRITE_LEVEL[$writeLevel])
                    ? Streams::$WRITE_LEVEL[$writeLevel]
                    : Streams::$WRITE_LEVEL['post'];

                $access = new Streams_Access();
                $access->publisherId = $publisherId;
                $access->streamName  = $streamName;
                $access->ofUserId    = $targetUserId;
                $access->writeLevel  = $wl;
                $access->readLevel   = Streams::$READ_LEVEL['content'];
                $access->save(true); // upsert

                $resultContent = "✓ Granted $targetDisplay write access ($writeLevel).";
                $instructions  = array(
                    'accessGranted' => true,
                    'targetUserId'  => $targetUserId,
                    'writeLevel'    => $writeLevel,
                );
                break;

            case 'revokeAccess':
                if (!$targetUserId) {
                    throw new Q_Exception_RequiredField(array('field' => 'targetUserId'));
                }
                $stream = Streams_Stream::fetch($asUserId, $publisherId, $streamName, true);
                if (!$stream->testAdminLevel('manage')) {
                    throw new Users_Exception_NotAuthorized();
                }
                Streams_Access::delete()
                    ->where(array(
                        'publisherId' => $publisherId,
                        'streamName'  => $streamName,
                        'ofUserId'    => $targetUserId,
                    ))->execute();

                $resultContent = "✓ Removed access for $targetDisplay.";
                $instructions  = array(
                    'accessRevoked' => true,
                    'targetUserId'  => $targetUserId,
                );
                break;

            default:
                throw new Q_Exception_WrongValue(array(
                    'field' => 'command', 'range' => 'create|grantAccess|revokeAccess',
                    'value' => $command
                ));
        }

    } catch (Users_Exception_NotAuthorized $e) {
        $resultContent = 'Not authorized to do that.';
        $messageType   = 'AI/command/error';
        $instructions  = array('error' => 'NotAuthorized');
    } catch (Exception $e) {
        $resultContent = $e->getMessage();
        $messageType   = 'AI/command/error';
        $instructions  = array('error' => $e->getMessage());
    }

    // Post result to the chat stream — appears in correct chronological order
    // alongside the acknowledgment message Node already posted
    // Post result to participant's chat stream (UI feedback)
    $chatStream = Streams_Stream::fetch($asUserId, $chatPublisherId, $chatStreamName);
    if ($chatStream) {
        $chatStream->post($asUserId, array(
            'type'         => $messageType,
            'content'      => $resultContent,
            'instructions' => json_encode($instructions),
        ));
    }

    // For access commands, also post a durable record to the presentation stream
    if ($publisherId && $streamName
    && in_array($command, array('grantAccess', 'revokeAccess'))
    && empty($instructions['error'])) {
        $presStream = Streams_Stream::fetch($asUserId, $publisherId, $streamName);
        if ($presStream) {
            $presStream->post($asUserId, array(
                'type'         => 'Media/presentation/access',
                'instructions' => json_encode(array(
                    'targetUserId' => $targetUserId,
                    'level'        => $writeLevel,
                    'action'       => ($command === 'grantAccess') ? 'grant' : 'revoke',
                    'relSec'       => 0,
                )),
            ));
        }
    }

    // Return result in slots so Node can act on it (e.g. wire new stream to tool)
    Q_Response::setSlot('result', $resultContent);
    Q_Response::setSlot('messageType', $messageType);
    Q_Response::setSlot('instructions', $instructions);
}
