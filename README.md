# pi-web

A small Rust web server that lets you drive [pi](https://github.com/matkey/pi) coding-agent sessions from anywhere on your LAN. It spawns one `pi --mode rpc` process per session and exposes a REST API plus WebSockets, with a single-page UI for chat, raw RPC commands and a live event stream.

```
browser ──► pi-web (axum) ──► pi --mode rpc  (stdin/stdout JSONL)
```

## Run

```bash
cargo run                       # http://localhost:8080
PI_WEB_PORT=8090 PI_WEB_ALLOWED_ROOTS=/home/robert ./target/debug/pi-web
```

Open `http://<host>:8080` in a browser (LAN access works, add `?token=...` if you set a token).

## Configuration (environment variables)

| variable | default | meaning |
| --- | --- | --- |
| `PI_WEB_HOST` | `0.0.0.0` | bind address |
| `PI_WEB_PORT` | `8080` | port |
| `PI_BIN` | `pi` | path to the pi binary |
| `PI_WEB_TOKEN` | *(none)* | if set, every request/WS must include `?token=` |
| `PI_WEB_TIMEOUT` | `120` | seconds to wait for an RPC response |
| `PI_WEB_ALLOWED_ROOTS` | *(empty = all)* | comma-separated list of directory roots a session may use |
| `PI_WEB_CWD` | *(none)* | create this session on startup |
| `PI_WEB_SESSION_DIR` | `~/.pi/agent/sessions` | where pi stores persisted sessions |

## REST API

| method | path | description |
| --- | --- | --- |
| GET | `/health` | liveness + live session count |
| GET | `/config` | effective configuration |
| GET | `/sessions` | list running sessions |
| POST | `/sessions` | start a session `{cwd, name?, model?, thinking?, session?, no_session?, extra_args?}` |
| GET | `/sessions/{id}` | `get_state` for the session |
| DELETE | `/sessions/{id}` | close the session (kills the pi process) |
| GET | `/sessions/{id}/snapshot` | message history (`get_messages`) |
| GET | `/sessions/{id}/commands` | list available RPC commands |
| GET | `/sessions/{id}/models` | available models |
| GET | `/sessions/<id>/stderr` | captured stderr of the pi process |
| POST | `/sessions/{id}/prompt` | `{text, streaming?}` sends a prompt |
| POST | `/sessions/{id}/abort` | stop the current run |
| POST | `/sessions/{id}/bash` | `{command}` run a shell command in the session |
| POST | `/sessions/{id}/command` | any raw RPC object, e.g. `{"type":"set_model","model":"..."} |
| GET | `/saved-sessions?cwd=…` | pi sessions persisted on disk (for resume) |

## WebSockets

* `/ws/events?token=…` — every event from every session (session lifecycle + agent events)
* `/ws/sessions/{id}?token=…` — transcript events for one session; you can also send RPC commands over the socket, useful for streaming:

```json
{"type": "steer", "message": "stop and try a different approach"}
{"type": "set_model", "model": "claude-opc-4.8-opus"}
{"type": "set_thinking_level", "level": "high"}
{"type": "extension_ui_response", "id": "req-123", "value": "yes"}
```

## Notes on RPC correlation

* Every request sent by pi-web carries a generated `id`; pi echoes it in the response.
* Some pi error responses do **not** echo the id, so a fallback correlates by the command name against the newest pending request.
* Events that carry their own `id` (for example `bash_execution_update`) are never treated as responses, so they cannot resolve a pending request.

## End-to-end smoke test

```bash
PI_WEB_PORT=8090 PI_WEB_ALLOWED_ROOTS=/home/robert cargo run
curl -s localhost:8090/health
curl -s -X POST localhost:8090/sessions -H 'content-type: application/json' \
  -d '{"cwd":"/home/robert/rdev/pi-web"}'
curl -s -X POST localhost:8090/sessions/sess-0/prompt -H 'content-type: application/json' \
  -d '{"text":"Say hello in one word"}'
curl -s localhost:8090/sessions/sess-0/snapshot | jq '.data.messages | length'
```
