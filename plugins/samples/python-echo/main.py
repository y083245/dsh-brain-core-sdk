"""A sample out-of-process plugin: stdio JSON-RPC, standard library only.

Every line written to stdout is one JSON-RPC 2.0 message and is flushed immediately; Python
buffers pipes by default.
"""

import json
import sys
import time
import uuid

API_VERSION = "1.0.0"
CHANNEL = "python-echo:private:echo"

next_id = 1
tool_calls = {}
RUN_ID = uuid.uuid4().hex


def send(message):
    sys.stdout.write(json.dumps(message, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def request(method, params):
    global next_id
    request_id = next_id
    next_id += 1
    send({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
    return request_id


def respond(request_id, result):
    send({"jsonrpc": "2.0", "id": request_id, "result": result})


def respond_error(request_id, code, message):
    send({
        "jsonrpc": "2.0",
        "id": request_id,
        "error": {"code": -32000, "message": message, "data": {"code": code, "details": {}}},
    })


def invoke_echo(request_id, args):
    text = args.get("text")
    if not isinstance(text, str) or text == "":
        respond_error(request_id, "INVALID_ARGUMENT", "text is required")
        return
    event = {
        "kind": "python-echo.echo",
        "channel": CHANNEL,
        "subjects": [],
        "actor": "python-echo",
        "content": {"text": text},
        "tEvent": int(time.time() * 1000),
        "idempotencyKey": "echo:%s:%s" % (RUN_ID, request_id),
    }
    ingest = request("memory.ingest", {"event": event})
    tool_calls[request_id] = {"text": text, "ingest": ingest}


def handle_request(message):
    method = message.get("method")
    params = message.get("params") or {}
    request_id = message.get("id")

    if method == "initialize":
        respond(request_id, {"apiVersion": API_VERSION})
        request("tools.register", {
            "name": "echo",
            "description": "Ingest the given text, then search memory for it.",
            "parameters": {
                "type": "object",
                "properties": {"text": {"type": "string"}},
                "required": ["text"],
            },
        })
        send({"jsonrpc": "2.0", "method": "plugin.ready"})
        return

    if method == "tool.invoke":
        if params.get("name") != "echo":
            respond_error(request_id, "NOT_FOUND", "no such tool")
            return
        invoke_echo(request_id, params.get("args") or {})
        return

    respond_error(request_id, "INVALID_ARGUMENT", "unknown method %s" % method)


def handle_response(message):
    request_id = message.get("id")
    if request_id is None:
        return
    for call_id, call in list(tool_calls.items()):
        if call.get("ingest") == request_id:
            if "error" in message:
                respond_error(call_id, "UNAVAILABLE", "memory.ingest failed")
                del tool_calls[call_id]
                return
            record_id = (message.get("result") or {}).get("id")
            call["record"] = record_id
            call["search"] = request("memory.search", {
                "request": {"query": call["text"], "scope": "here"},
                "view": {"channel": CHANNEL},
            })
            return
        if call.get("search") == request_id:
            if "error" in message:
                respond_error(call_id, "UNAVAILABLE", "memory.search failed")
                del tool_calls[call_id]
                return
            items = (message.get("result") or {}).get("items") or []
            ids = [str((item.get("record") or {}).get("id")) for item in items]
            respond(call_id, "echo %s: %d hit(s) %s" % (call["text"], len(items), ",".join(ids)))
            del tool_calls[call_id]
            return


def main():
    for line in sys.stdin:
        line = line.strip()
        if line == "":
            continue
        try:
            message = json.loads(line)
        except ValueError:
            continue
        if message.get("method") == "shutdown":
            return
        if "method" in message:
            handle_request(message)
        elif "id" in message:
            handle_response(message)


if __name__ == "__main__":
    main()
