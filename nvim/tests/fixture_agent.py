#!/usr/bin/env python3
import json
import sys
import time


def send(message):
    sys.stdout.write(json.dumps(message, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def response(request_id, result):
    send({"jsonrpc": "2.0", "id": request_id, "result": result})


def update(session_id, payload):
    send(
        {
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": session_id,
                "update": payload,
            },
        }
    )


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
    elif method == "_phenix/session_tree/get":
        response(
            request_id,
            {
                "id": params["tree_id"],
                "definition_id": "phenix.harness",
                "root": "fixture-root",
                "nodes": [],
                "objectives": [],
                "active_workflow": None,
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
    elif method == "_phenix/node/execute":
        command = params.get("command") or {}
        if command.get("kind") == "steer":
            update(
                params["tree_id"],
                {
                    "sessionUpdate": "agent_message_chunk",
                    "content": {
                        "type": "text",
                        "text": "steered: " + command.get("text", ""),
                    },
                },
            )
        response(request_id, {"events": []})
    elif method == "session/prompt":
        text = "\n\n".join(
            block.get("text", "")
            for block in params.get("prompt", [])
            if block.get("type") == "text"
        )
        update(
            params["sessionId"],
            {
                "sessionUpdate": "agent_thought_chunk",
                "content": {"type": "text", "text": "thinking about: " + text},
            },
        )

        if text == "scroll while streaming":
            time.sleep(0.25)

        if text == "rich transcript":
            update(
                params["sessionId"],
                {
                    "sessionUpdate": "tool_call",
                    "toolCallId": "fixture-tool",
                    "title": "read README",
                    "status": "in_progress",
                    "rawInput": {"path": "README.md"},
                },
            )
            update(
                params["sessionId"],
                {
                    "sessionUpdate": "tool_call_update",
                    "toolCallId": "fixture-tool",
                    "status": "completed",
                    "rawOutput": {"summary": "README contents"},
                },
            )
            assistant_text = "**done** with the tool call"
        else:
            assistant_text = "echo: " + text

        update(
            params["sessionId"],
            {
                "sessionUpdate": "agent_message_chunk",
                "content": {"type": "text", "text": assistant_text},
            },
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
