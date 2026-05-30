"""Minimal ACP (Agent Client Protocol) agent — echo implementation.

Speaks JSON-RPC 2.0 over stdio. One line == one message (LSP/ACP convention
allows either Content-Length framing or line-delimited; we use line-delimited
because it is the simplest interop shape and the driver matches it).

Implements the three baseline ACP methods:
  - initialize       -> returns protocolVersion + capabilities
  - session/new      -> returns a fresh sessionId
  - session/prompt   -> sends one session/update notification with an
                        assistant_message_chunk echoing the user text,
                        then returns { stopReason: "end_turn" }
"""

from __future__ import annotations
import json
import sys
import uuid


def write_message(msg: dict) -> None:
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


def notify(method: str, params: dict) -> None:
    write_message({"jsonrpc": "2.0", "method": method, "params": params})


def respond(req_id, result: dict) -> None:
    write_message({"jsonrpc": "2.0", "id": req_id, "result": result})


def handle(msg: dict) -> bool:
    """Return True to keep running, False to exit."""
    method = msg.get("method")
    req_id = msg.get("id")
    params = msg.get("params", {}) or {}

    if method == "initialize":
        respond(
            req_id,
            {
                "protocolVersion": 1,
                "agentCapabilities": {
                    "loadSession": False,
                    "promptCapabilities": {
                        "image": False,
                        "audio": False,
                        "embeddedContext": False,
                    },
                },
                "agentInfo": {
                    "name": "fc-acp-echo",
                    "title": "FC ACP Echo Agent",
                    "version": "0.1.0",
                },
            },
        )
        return True

    if method == "session/new":
        respond(req_id, {"sessionId": f"sess-{uuid.uuid4().hex[:12]}"})
        return True

    if method == "session/prompt":
        session_id = params.get("sessionId", "")
        prompt_blocks = params.get("prompt", []) or []
        text_in = "".join(
            b.get("text", "") for b in prompt_blocks if b.get("type") == "text"
        )
        reply = f"echo: {text_in}"

        # Stream the answer as a single assistant_message_chunk update.
        notify(
            "session/update",
            {
                "sessionId": session_id,
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "content": {"type": "text", "text": reply},
                },
            },
        )
        respond(req_id, {"stopReason": "end_turn"})
        return True

    if method == "shutdown":
        respond(req_id, {})
        return False

    # Unknown method — JSON-RPC method-not-found.
    if req_id is not None:
        write_message(
            {
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {"code": -32601, "message": f"method not found: {method}"},
            }
        )
    return True


def main() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not handle(msg):
            break


if __name__ == "__main__":
    main()
