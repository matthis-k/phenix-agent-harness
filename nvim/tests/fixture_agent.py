#!/usr/bin/env python3
import json
import sys
import time


def send(message):
    sys.stdout.write(json.dumps(message, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def response(request_id, result):
    send({"jsonrpc": "2.0", "id": request_id, "result": result})


for raw_line in sys.stdin:
    raw_line = raw_line.strip()
    if not raw_line:
        continue
    message = json.loads(raw_line)
    method = message.get("method")
    request_id = message.get("id")
    params = message.get("params") or {}

    if method == "initialize":
        response(
            request_id,
            {
                "protocolVersion": 1,
                "agentCapabilities": {},
            },
        )
    elif method == "_phenix/config/apply":
        response(
            request_id,
            {
                "revision": 1,
                "definition_id": params["input"]["definition_id"],
                "router": params["input"]["router"],
            },
        )
    elif method == "session/new":
        response(
            request_id,
            {
                "sessionId": "fixture-session",
                "configOptions": [
                    {
                        "id": "model",
                        "name": "Model",
                        "category": "model",
                        "type": "select",
                        "currentValue": "fixture-model",
                        "options": [
                            {"value": "fixture-model", "name": "Fixture Model"},
                            {"value": "other-model", "name": "Other Model"},
                        ],
                    }
                ],
            },
        )
    elif method == "session/set_config_option":
        response(
            request_id,
            {
                "configOptions": [
                    {
                        "id": params["configId"],
                        "name": "Model",
                        "category": "model",
                        "type": "select",
                        "currentValue": params["value"],
                        "options": [
                            {"value": "fixture-model", "name": "Fixture Model"},
                            {"value": "other-model", "name": "Other Model"},
                        ],
                    }
                ]
            },
        )
    elif method == "session/prompt":
        text = "\n\n".join(
            block.get("text", "")
            for block in params.get("prompt", [])
            if block.get("type") == "text"
        )
        send(
            {
                "jsonrpc": "2.0",
                "method": "session/update",
                "params": {
                    "sessionId": params["sessionId"],
                    "update": {
                        "sessionUpdate": "agent_thought_chunk",
                        "content": {"type": "text", "text": "thinking about: " + text},
                    },
                },
            }
        )
        if text == "scroll while streaming":
            time.sleep(0.25)
        send(
            {
                "jsonrpc": "2.0",
                "method": "session/update",
                "params": {
                    "sessionId": params["sessionId"],
                    "update": {
                        "sessionUpdate": "agent_message_chunk",
                        "content": {"type": "text", "text": "echo: " + text},
                    },
                },
            }
        )
        response(request_id, {"stopReason": "end_turn"})
    elif method == "session/close":
        response(request_id, {})
    elif request_id is not None:
        send(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "error": {"code": -32601, "message": "unknown method: " + str(method)},
            }
        )
