"""ACP driver — runs inside the createos-sandbox.

Spawns acp_agent.py as a subprocess and speaks JSON-RPC 2.0 over its stdio,
walking the canonical ACP turn:

    1. initialize        (handshake)
    2. session/new       (get sessionId)
    3. session/prompt    (send user text, collect assistant chunks)
    4. shutdown          (graceful exit)

Every wire frame sent or received is mirrored to stderr prefixed with "<<<"
(host -> agent) or ">>>" (agent -> host) so the calling host can prove the
JSON-RPC traffic actually occurred.
"""

from __future__ import annotations
import json
import os
import subprocess
import sys


AGENT_PATH = os.environ.get("ACP_AGENT", "/tmp/acp_agent.py")


def log_frame(direction: str, frame: dict) -> None:
    sys.stderr.write(f"{direction} {json.dumps(frame)}\n")
    sys.stderr.flush()


class AcpClient:
    def __init__(self, proc: subprocess.Popen) -> None:
        self.proc = proc
        self._next_id = 0

    def _send(self, frame: dict) -> None:
        assert self.proc.stdin is not None
        log_frame("<<<", frame)
        self.proc.stdin.write(json.dumps(frame) + "\n")
        self.proc.stdin.flush()

    def _read(self) -> dict:
        assert self.proc.stdout is not None
        line = self.proc.stdout.readline()
        if not line:
            raise RuntimeError("agent closed stdout before response")
        frame = json.loads(line)
        log_frame(">>>", frame)
        return frame

    def request(self, method: str, params: dict | None = None) -> dict:
        self._next_id += 1
        req_id = self._next_id
        self._send(
            {"jsonrpc": "2.0", "id": req_id, "method": method, "params": params or {}}
        )
        # Drain notifications until the matching response arrives.
        notifications: list[dict] = []
        while True:
            msg = self._read()
            if msg.get("id") == req_id:
                if "error" in msg:
                    raise RuntimeError(f"ACP error: {msg['error']}")
                return {"result": msg.get("result", {}), "notifications": notifications}
            if "method" in msg and "id" not in msg:
                notifications.append(msg)
                continue
            # Out-of-band response: ignore.

    def notify(self, method: str, params: dict | None = None) -> None:
        self._send({"jsonrpc": "2.0", "method": method, "params": params or {}})


def main() -> int:
    prompt_text = sys.argv[1] if len(sys.argv) > 1 else "hello from createos-sandbox"

    proc = subprocess.Popen(
        ["python3", AGENT_PATH],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )
    try:
        client = AcpClient(proc)

        init = client.request(
            "initialize",
            {
                "protocolVersion": 1,
                "clientCapabilities": {
                    "fs": {"readTextFile": False, "writeTextFile": False},
                    "terminal": False,
                },
                "clientInfo": {
                    "name": "acp-driver",
                    "title": "createos-sandbox ACP Driver",
                    "version": "0.1.0",
                },
            },
        )
        agent_info = init["result"].get("agentInfo", {})

        new_session = client.request("session/new", {"cwd": "/tmp", "mcpServers": []})
        session_id = new_session["result"]["sessionId"]

        prompt_resp = client.request(
            "session/prompt",
            {
                "sessionId": session_id,
                "prompt": [{"type": "text", "text": prompt_text}],
            },
        )

        # Pull assistant text from the streamed session/update notifications.
        assistant_text_parts: list[str] = []
        for notif in prompt_resp["notifications"]:
            if notif.get("method") != "session/update":
                continue
            update = notif.get("params", {}).get("update", {})
            if update.get("sessionUpdate") != "agent_message_chunk":
                continue
            content = update.get("content", {})
            if content.get("type") == "text":
                assistant_text_parts.append(content.get("text", ""))
        assistant_text = "".join(assistant_text_parts)

        # Final structured summary on stdout for the host to consume.
        summary = {
            "agent": agent_info,
            "sessionId": session_id,
            "prompt": prompt_text,
            "assistant": assistant_text,
            "stopReason": prompt_resp["result"].get("stopReason"),
        }
        sys.stdout.write(json.dumps(summary, indent=2) + "\n")

        try:
            client.request("shutdown")
        except Exception:
            pass
        return 0
    finally:
        try:
            if proc.stdin:
                proc.stdin.close()
            proc.wait(timeout=5)
        except Exception:
            proc.kill()


if __name__ == "__main__":
    sys.exit(main())
