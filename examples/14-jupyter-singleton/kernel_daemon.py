#!/usr/bin/env python3
"""Long-lived in-sandbox Python kernel driver.

Hosts a single InteractiveInterpreter so state (variables, imports,
defined functions) persists across "cells". Each cell arrives as a
JSON request over a Unix-domain socket; we run it, capture stdout /
stderr / repr-of-last-expression, and reply with a JSON response.

Wire format (newline-delimited JSON, one request and one reply per
connection):

    request:  {"code": "import math\\nmath.pi"}
    reply:    {"stdout": "", "stderr": "", "result": "3.141592653589793", "ok": true}

We use stdlib only (`code.InteractiveInterpreter` + `ast`) — Jupyter
semantics without depending on IPython being present in the rootfs.
The daemon catches every exception so a bad cell never crashes the
session; tracebacks land in `stderr` of that cell's reply.
"""
import ast
import code as codemod
import io
import json
import os
import socket
import sys
import traceback
from contextlib import redirect_stderr, redirect_stdout

SOCK_PATH = "/tmp/kernel.sock"
READY_PATH = "/tmp/kernel.ready"

# One persistent namespace + interpreter shared across every cell.
NAMESPACE: dict = {"__name__": "__main__"}
interp = codemod.InteractiveInterpreter(locals=NAMESPACE)


def run_cell(source: str) -> dict:
    """Jupyter-style execution: run all statements, then if the last
    node is an expression, evaluate it and return its repr as the
    cell's result."""
    out, err = io.StringIO(), io.StringIO()
    result_repr = ""
    ok = True
    try:
        tree = ast.parse(source, mode="exec")
    except SyntaxError as e:
        err.write("".join(traceback.format_exception_only(type(e), e)))
        return {"stdout": "", "stderr": err.getvalue(), "result": "", "ok": False}

    last_expr = None
    body = list(tree.body)
    if body and isinstance(body[-1], ast.Expr):
        last_expr = body.pop()

    # Intentional `exec` + `eval` of user-supplied code — this daemon
    # IS the Jupyter-style kernel; running arbitrary Python is its
    # entire job. The VM the daemon runs inside is the security
    # boundary; nothing here is reachable from outside the sandbox.
    try:
        with redirect_stdout(out), redirect_stderr(err):
            if body:
                exec(compile(ast.Module(body=body, type_ignores=[]), "<cell>", "exec"), NAMESPACE)
            if last_expr is not None:
                value = eval(
                    compile(ast.Expression(body=last_expr.value), "<cell>", "eval"),
                    NAMESPACE,
                )
                if value is not None:
                    try:
                        result_repr = repr(value)
                    except Exception as e:  # noqa: BLE001
                        result_repr = f"<unreprable: {e!r}>"
    except SystemExit:
        ok = False
        err.write("cell called sys.exit(); ignoring to keep kernel alive\n")
    except BaseException:  # noqa: BLE001
        ok = False
        # Hide the daemon frames so the traceback shows just the cell.
        err.write(traceback.format_exc())
    return {"stdout": out.getvalue(), "stderr": err.getvalue(), "result": result_repr, "ok": ok}


def serve() -> None:
    if os.path.exists(SOCK_PATH):
        os.unlink(SOCK_PATH)
    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    srv.bind(SOCK_PATH)
    srv.listen(8)
    os.chmod(SOCK_PATH, 0o666)
    # Touch a ready file so the driver knows we're accepting connections.
    with open(READY_PATH, "w") as f:
        f.write(str(os.getpid()))
    sys.stderr.write(f"kernel daemon ready pid={os.getpid()} sock={SOCK_PATH}\n")
    sys.stderr.flush()

    while True:
        conn, _ = srv.accept()
        try:
            buf = bytearray()
            while True:
                chunk = conn.recv(65536)
                if not chunk:
                    break
                buf.extend(chunk)
                # Terminator: a single newline after a valid JSON object.
                if buf.endswith(b"\n"):
                    break
            if not buf:
                continue
            try:
                req = json.loads(buf.decode("utf-8"))
            except Exception as e:  # noqa: BLE001
                conn.sendall(
                    (json.dumps({"ok": False, "stdout": "", "stderr": f"bad request: {e!r}", "result": ""}) + "\n").encode("utf-8")
                )
                continue
            reply = run_cell(req.get("code", ""))
            conn.sendall((json.dumps(reply) + "\n").encode("utf-8"))
        finally:
            conn.close()


if __name__ == "__main__":
    serve()
