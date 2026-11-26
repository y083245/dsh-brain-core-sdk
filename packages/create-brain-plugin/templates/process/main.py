#!/usr/bin/env python3
"""A Brain Core process plugin using only the standard library.

The kernel and the plugin exchange one JSON-RPC 2.0 message per line over stdio. Every line must
be flushed: Python buffers stdout when it is a pipe.
"""

import json
import sys

API_VERSION = "1.0.0"

TOOLS = {
    "hello": {
        "name": "hello",
        "description": "Say hello to the user.",
        "parameters": {"type": "object", "properties": {}},
    },
}


def send(message):
    sys.stdout.write(json.dumps(message, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def reply(request_id, value):
    send({"jsonrpc": "2.0", "id": request_id, "result": value})


def fail(request_id, code, message):
    send({"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}})


def notify(method, params=None):
    message = {"jsonrpc": "2.0", "method": method}
    if params is not None:
        message["params"] = params
    send(message)


_next_id = 0


def send_request(method, params=None):
    global _next_id
    _next_id += 1
    message = {"jsonrpc": "2.0", "id": "plugin-%d" % _next_id, "method": method}
    if params is not None:
        message["params"] = params
    send(message)


def initialize(request):
    reply(request.get("id"), {"apiVersion": API_VERSION})
    for tool in TOOLS.values():
        send_request("tools.register", tool)
    notify("plugin.ready")


def tool_invoke(request):
    params = request.get("params") or {}
    if params.get("name") not in TOOLS:
        fail(request.get("id"), -32602, "unknown tool: %s" % params.get("name"))
        return
    reply(request.get("id"), "hello from __ID__")


def main():
    for line in sys.stdin:
        line = line.strip()
        if line == "":
            continue
        try:
            request = json.loads(line)
        except ValueError:
            fail(None, -32700, "parse error")
            continue
        method = request.get("method")
        if method is None:
            # The kernel's answer to one of our own requests; tools.register failures are worth a note.
            if request.get("error") is not None:
                sys.stderr.write("plugin request failed: %s\n" % request["error"].get("message"))
                sys.stderr.flush()
        elif method == "initialize":
            initialize(request)
        elif method == "tool.invoke":
            tool_invoke(request)
        elif method == "shutdown":
            return 0
        elif "id" in request:
            fail(request["id"], -32601, "unknown method: %s" % method)
    return 0


if __name__ == "__main__":
    sys.exit(main())
