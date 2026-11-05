# pi-web

A Rust web server and agent console that lets you drive [pi](https://pi.dev) coding-agent sessions from anywhere on your LAN. It spawns one `pi --mode rpc` process per session and exposes a REST API plus WebSockets, with a full-featured single-page web interface designed specifically for Pi.

```
browser ──► pi-web (axum) ──► pi --mode rpc  (stdin/stdout JSONL)
```

## Features

- **Authentic Pi Theme & Layout**: Built on Pi's official Dark/Light color palette with thinking-level border indicators (`off` → `max`), resizable sidebar tabs (`Sessions`, `Tree`, `Commands`, `Inspector`), and keyboard shortcuts matching Pi's TUI (`Shift+Tab`, `Alt+T`, `Alt+O`, `Alt+Enter`, `Alt+Up`, `Ctrl+L`, `Esc`).
- **Rich Markdown & Tool Execution Cards**:
  - Offline Markdown rendering (`marked.min.js`) with code block copy buttons.
  - Live streaming of **Thinking/Reasoning** blocks (`thinking_delta`), **Assistant Text** (`text_delta`), and **Tool Calls** (`toolcall_start`/`tool_execution_update`/`tool_execution_end`).
  - Specialized tool cards for `bash` (`$ command`), `edit` (colorized unified diffs), `read`, `write`, `grep`, `find`, `ls`, and `codemode` (`nestedCalls`).
- **Direct Shell Mode (`!cmd` & `!!cmd`)**: Run shell commands directly from the composer with live streaming `bash_execution_update` output, either included in the next LLM context (`!cmd`) or omitted (`!!cmd`).
- **Slash Commands, Skills & Prompt Templates (`/`)**: Interactive `/` autocomplete popup powered by `get_commands` plus built-in session commands (`/new`, `/compact`, `/clone`, `/name`, `/export`, `/tree`, `/clear`).
- **Session Tree & Branching**: Inspect the full session entry tree (`get_tree`), filter by role, and **Fork** (`fork`) from any user prompt or **Clone** (`clone`) the active branch.
- **Image Attachments**: Paste images from clipboard (`Ctrl+V`), drag-and-drop, or select image files to attach `ImageContent` payloads to `prompt`, `steer`, or `follow_up`.
- **Full Extension UI Subprotocol**: Supports Pi's `extension_ui_request` / `extension_ui_response` dialogs (`select`, `confirm`, `input`, `editor` with timeouts), toast notifications (`notify`), status bar entries (`setStatus`), and widgets (`setWidget`).
- **Interactive Folder Browser & Saved Sessions Preview**: Browse allowed directories when creating a session and inspect saved sessions on disk with session names, message counts, and first-prompt previews.

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
| GET | `/dirs?path=…` | list directories for folder picker (respects `PI_WEB_ALLOWED_ROOTS`) |
| GET | `/sessions` | list running sessions (with `id`, `cwd`, `name`, `alive`) |
| POST | `/sessions` | start a session `{cwd, name?, model?, thinking?, session?, no_session?, extra_args?}` |
| GET | `/sessions/{id}` | `get_state` for the session |
| DELETE | `/sessions/{id}` | close the session (kills the pi process) |
| GET | `/sessions/{id}/snapshot` | message history (`get_messages`) |
| GET | `/sessions/{id}/tree` | full conversation tree (`get_tree`) |
| GET | `/sessions/{id}/stats` | token & cost statistics (`get_session_stats`) |
| GET | `/sessions/{id}/commands` | list available slash commands, skills & templates (`get_commands`) |
| GET | `/sessions/{id}/models` | available models (`get_available_models`) |
| GET | `/sessions/{id}/thinking-levels` | supported thinking levels for current model (`get_available_thinking_levels`) |
| GET | `/sessions/{id}/stderr` | captured stderr of the pi process |
| GET | `/sessions/{id}/export` | export and download standalone Pi session HTML (`export_html`) |
| POST | `/sessions/{id}/prompt` | `{text, streaming?, images?}` sends a prompt |
| POST | `/sessions/{id}/abort` | stop the current run |
| POST | `/sessions/{id}/bash` | `{command, exclude_from_context?}` run a shell command in the session |
| POST | `/sessions/{id}/command` | any raw RPC object, e.g. `{"type":"set_model","provider":"anthropic","modelId":"..."}` |
| GET | `/saved-sessions?cwd=…` | pi sessions persisted on disk with name, first prompt preview & message count |

## WebSockets

* `/ws/events?token=…` — every event from every session (session lifecycle + agent events)
* `/ws/sessions/{id}?token=…` — transcript events and initial snapshot (`state`, `history`, `stats`, `models`, `thinking_levels`, `commands`) for one session; you can also send RPC commands over the socket:

```json
{"type": "steer", "message": "stop and try a different approach"}
{"type": "set_model", "provider": "anthropic", "modelId": "claude-sonnet-4-20250514"}
{"type": "set_thinking_level", "level": "high"}
{"type": "extension_ui_response", "id": "req-123", "confirmed": true}
```
