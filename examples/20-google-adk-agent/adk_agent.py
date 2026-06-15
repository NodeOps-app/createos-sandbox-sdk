"""Google ADK agent whose tools execute inside an FC sandbox.

Runs on the host (this process). The FC sandbox is created and owned by the
TypeScript entry (index.ts); its id and the FC connection creds arrive via env:

    FC_SANDBOX_ID  — the sandbox this agent drives
    CREATEOS_SANDBOX_BASE_URL    — control-plane base URL
    CREATEOS_SANDBOX_API_KEY     — sent as the X-Api-Key header

Three ADK tools wrap the FC HTTP API so the agent reasons over a small coding
task and every step lands as a real sandbox operation:

    run_command  -> POST /v1/sandboxes/{id}/exec   (buffered command)
    write_file   -> PUT  /v1/sandboxes/{id}/files  (upload bytes)
    read_file    -> GET  /v1/sandboxes/{id}/files  (download bytes)

The LLM backing ADK is reached through LiteLLM pointed at an OpenAI-compatible
proxy (OPENAI_API_URL / OPENAI_API_KEY / OPENAI_MODEL). Every tool call is
printed as it happens, and the agent's final answer is printed at the end, so
the whole tool-call trace is visible end-to-end.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

from google.adk.agents import Agent
from google.adk.models.lite_llm import LiteLlm
from google.adk.runners import InMemoryRunner
from google.genai import types as genai_types

APP_NAME = "fc-adk-agent"
WORKDIR = "/root/adk-workspace"

SANDBOX_ID = os.environ["FC_SANDBOX_ID"]
CREATEOS_SANDBOX_BASE_URL = os.environ["CREATEOS_SANDBOX_BASE_URL"].rstrip("/")
CREATEOS_SANDBOX_API_KEY = os.environ["CREATEOS_SANDBOX_API_KEY"]


# ── FC HTTP client (stdlib only) ──────────────────────────────────────────


class CreateosSandboxError(RuntimeError):
    pass


def _request(method, path, *, query=None, json_body=None, raw_body=None,
             content_type=None, expect_json=True):
    url = f"{CREATEOS_SANDBOX_BASE_URL}{path}"
    if query:
        url += "?" + urllib.parse.urlencode(query)

    data = raw_body
    headers = {"X-Api-Key": CREATEOS_SANDBOX_API_KEY, "Accept": "application/json"}
    if json_body is not None:
        data = json.dumps(json_body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    elif content_type is not None:
        headers["Content-Type"] = content_type

    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            payload = resp.read()
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")[:400]
        raise CreateosSandboxError(f"{method} {path} -> HTTP {e.code}: {body}") from e
    except urllib.error.URLError as e:
        raise CreateosSandboxError(f"{method} {path} -> connection error: {e.reason}") from e

    if not expect_json:
        return payload

    # JSend envelope: { "status": "success", "data": <T> }. Unwrap to data.
    envelope = json.loads(payload.decode("utf-8"))
    if envelope.get("status") != "success":
        raise CreateosSandboxError(f"{method} {path} -> non-success envelope: {envelope}")
    return envelope.get("data")


def fc_exec(cmd, args):
    return _request(
        "POST",
        f"/v1/sandboxes/{urllib.parse.quote(SANDBOX_ID)}/exec",
        json_body={"cmd": cmd, "args": args},
    )


def fc_upload(path, body):
    _request(
        "PUT",
        f"/v1/sandboxes/{urllib.parse.quote(SANDBOX_ID)}/files",
        query={"path": path},
        raw_body=body,
        content_type="application/octet-stream",
    )


def fc_download(path):
    return _request(
        "GET",
        f"/v1/sandboxes/{urllib.parse.quote(SANDBOX_ID)}/files",
        query={"path": path},
        expect_json=False,
    )


# ── ADK tools (each call hits the FC sandbox over HTTP) ────────────────────


def run_command(command: str) -> dict:
    """Run a shell command inside the FC sandbox and return its output.

    Use this to execute scripts, inspect the workspace, or run Python. The
    command runs through `bash -lc` so pipes and redirection work.

    Args:
        command: The shell command line to execute inside the sandbox.

    Returns:
        A dict with stdout, stderr and exit_code from the sandbox.
    """
    print(f"\n[tool] run_command: {command}", flush=True)
    resp = fc_exec("bash", ["-lc", command])
    result = resp.get("result", {})
    out = {
        "stdout": result.get("stdout", ""),
        "stderr": result.get("stderr", ""),
        "exit_code": result.get("exit_code", -1),
    }
    print(f"       -> exit={out['exit_code']} stdout={out['stdout'][:200]!r}", flush=True)
    return out


def write_file(path: str, content: str) -> dict:
    """Write a UTF-8 text file into the FC sandbox workspace.

    Args:
        path: Path relative to the workspace (e.g. "compute.py").
        content: The full text content to write.

    Returns:
        A dict with the absolute path written and the byte count.
    """
    if path.startswith("/") or ".." in path:
        return {"error": "path must stay inside the workspace"}
    abs_path = f"{WORKDIR}/{path}"
    print(f"\n[tool] write_file: {abs_path} ({len(content)} bytes)", flush=True)
    fc_exec("mkdir", ["-p", WORKDIR])
    fc_upload(abs_path, content.encode("utf-8"))
    return {"path": abs_path, "bytes": len(content)}


def read_file(path: str) -> dict:
    """Read a UTF-8 text file back from the FC sandbox workspace.

    Args:
        path: Path relative to the workspace (e.g. "result.json").

    Returns:
        A dict with the file content, or an error string.
    """
    if path.startswith("/") or ".." in path:
        return {"error": "path must stay inside the workspace"}
    abs_path = f"{WORKDIR}/{path}"
    print(f"\n[tool] read_file: {abs_path}", flush=True)
    try:
        content = fc_download(abs_path).decode("utf-8", "replace")
    except CreateosSandboxError as e:
        return {"error": str(e)}
    print(f"       -> {content[:200]!r}", flush=True)
    return {"path": abs_path, "content": content}


# ── agent wiring ───────────────────────────────────────────────────────────


def build_agent() -> Agent:
    model = LiteLlm(
        model=f"openai/{os.environ['OPENAI_MODEL']}",
        api_base=os.environ.get("OPENAI_API_URL") or os.environ.get("OPENAI_BASE_URL"),
        api_key=os.environ["OPENAI_API_KEY"],
    )
    return Agent(
        model=model,
        name="fc_sandbox_agent",
        description="An agent that performs coding tasks inside an FC microVM sandbox.",
        instruction=(
            "You are a coding agent. Your tools run inside an isolated FC microVM "
            "sandbox: run_command executes shell commands, write_file writes files "
            "into the workspace, read_file reads them back. "
            "You MUST NOT compute or guess any result yourself. Every number you "
            "report has to come from a file the sandbox produced. Always: "
            "write the script with write_file, execute it with run_command, then "
            "read_file the output file and base your answer only on its contents. "
            "When you have the verified result, state it plainly and concisely."
        ),
        tools=[run_command, write_file, read_file],
    )


PROMPT = (
    "In the sandbox, write a Python script compute.py that reads no input and "
    "computes the sum of the squares of all prime numbers below 50, then writes "
    'the result as JSON {"sum_of_prime_squares": <n>} to result.json and prints '
    "it. Run the script, read result.json back, and tell me the final number."
)


async def run() -> int:
    agent = build_agent()
    runner = InMemoryRunner(agent=agent, app_name=APP_NAME)
    session = await runner.session_service.create_session(
        app_name=APP_NAME, user_id="host"
    )

    print(f"sandbox: {SANDBOX_ID}")
    print(f"model:   openai/{os.environ['OPENAI_MODEL']} via {os.environ.get('OPENAI_API_URL')}")
    print(f"\n=== task ===\n{PROMPT}\n", flush=True)

    message = genai_types.Content(
        role="user", parts=[genai_types.Part(text=PROMPT)]
    )

    final_text = ""
    tool_calls = 0
    print("=== tool-call trace ===", flush=True)
    async for event in runner.run_async(
        user_id="host", session_id=session.id, new_message=message
    ):
        if not (event.content and event.content.parts):
            continue
        for part in event.content.parts:
            call = getattr(part, "function_call", None)
            if call is not None:
                tool_calls += 1
                print(f"  -> call {call.name}({json.dumps(dict(call.args))})", flush=True)
            resp = getattr(part, "function_response", None)
            if resp is not None:
                print(f"  <- {resp.name} returned {json.dumps(resp.response)[:200]}", flush=True)
        if event.is_final_response():
            final_text = "".join(p.text for p in event.content.parts if p.text)

    print(f"\n=== final agent answer ({tool_calls} sandbox tool calls) ===")
    print(final_text.strip() or "(no final text)")
    return 0 if tool_calls > 0 else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(run()))
