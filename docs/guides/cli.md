# CLI Reference

> See also: [README](../../README.md) · [Detailed Design](../detailed-design.md)

### `tachu init`

Initialize a new Tachu project workspace.

```
tachu init [options]

Options:
  --template <name>    Scaffold template: minimal | full  (default: minimal)
  --force              Overwrite existing files without prompting
  --path <dir>         Target directory                   (default: CWD)
  --provider <name>    Default provider: openai | anthropic | mock  (default: mock)
  --no-examples        Skip generating example rule/tool descriptors
  -h, --help           Show help
```

Generates `.tachu/` directory skeleton + `tachu.config.ts` + `.gitignore` entries.

---

### `tachu run <prompt>`

Execute a single prompt and stream the result to stdout.

```
tachu run <prompt> [options]

Arguments:
  <prompt>             The prompt text (or pipe via stdin)

Options:
  --session <id>          Use a specific session ID
  --resume                Resume the most recent session
  --model <name>          Override the high-reasoning model
  --provider <name>       Override the default provider
  --api-base <url>        Override provider baseURL (gateway / Azure / LiteLLM)
  --api-key <key>         Override provider apiKey (env var still recommended)
  --organization <id>     Override OpenAI organization ID
  --input <file>          Read prompt from a file
  --json                  Parse prompt as JSON (structured input)
  --image <path>          Attach a local image for multimodal input (repeatable; MIME from file magic)
  --text-to-image         Text-to-image mode (requires capabilityMapping["text-to-image"] in tachu.config)
  --save-image <path>     Download generated images to a file or directory (text-to-image runs)
  --output <fmt>          Output format: text | json | markdown  (default: text)
  --markdown              Enable terminal Markdown rendering for --output text
                          (default: on when stdout is a TTY and NO_COLOR is unset)
  --no-markdown           Disable terminal Markdown rendering (force raw text)
  --no-validation         Skip Phase 8 result validation
  --plan-mode             Enable Plan mode (pause after Phase 5 for approval)
  --verbose, -v           Verbose output (phase transitions, each phase line has `(Nms)` duration appended)
  --debug                 Debug mode: implies --verbose and streams every engine observability
                          event (phase / llm / tool / MCP) to stderr, color-coded.
                          Safe for `-o json` pipelines (stdout is not polluted).
  --no-color              Disable ANSI color output (also respects NO_COLOR env var;
                          implies --no-markdown since Markdown rendering is color-based)
  --ink                   Use Ink full-screen renderer on TTY (default: on)
  --no-ink                Disable Ink; use standard terminal streaming (also: TACHU_INK=0)
  --timeout <ms>          Wall-time limit (overrides budget.maxWallTimeMs)
  -h, --help              Show help
```

> **Note:** `--image` is parsed from the process argv (repeat `--image` per file). `--json` cannot be combined with `--image` or `--text-to-image`.

---

### `tachu session`

Scriptable session management (same `.tachu/sessions/` store as `tachu chat` / `tachu run`). For interactive REPL, use `tachu chat --session <id>` or `tachu chat --resume`.

```
tachu session <subcommand> [options]

Subcommands:
  list                     List all sessions (message counts from .tachu/memory/*.jsonl)
  export <id> <path>       Export a session to a Markdown file
  resume <id>              Verify session exists and print summary (use chat to continue)

Options (per subcommand):
  --no-color               Disable ANSI color output
  -h, --help               Show help
```

---

### `tachu chat`

Start an interactive multi-turn chat session.

```
tachu chat [options]

Options:
  --session <id>          Use a specific session ID
  --resume                Resume the most recent session
  --history               List all sessions and exit (no interactive prompt)
  --export <file>         Export a session to Markdown and exit
  --model <name>          Override the high-reasoning model
  --provider <name>       Override the default provider
  --api-base <url>        Override provider baseURL (gateway / Azure / LiteLLM)
  --api-key <key>         Override provider apiKey (env var still recommended)
  --organization <id>     Override OpenAI organization ID
  --plan-mode             Enable Plan mode
  --verbose, -v           Verbose output (phase lines carry `(Nms)` duration)
  --debug                 Debug mode: implies --verbose and streams observability events to stderr.
                          Also prints per-turn MCP gated-group activation summary.
  --no-color              Disable color output
  -h, --help              Show help
```

**Built-in interactive commands** (prefix with `/`):

| Command | Description |
|---------|-------------|
| `/exit` | Save session and quit |
| `/reset` | Clear the current session's memory |
| `/new` | Start a new session |
| `/list` | List all saved sessions |
| `/load <id>` | Switch to a specific session |
| `/save` | Manually persist the current session |
| `/export <path>` | Export session to a Markdown file |
| `/history` | Show this session's message history |
| `/stats` | Show token usage, tool calls, and remaining budget |
| `/help` | Show all commands |

**Ctrl+C behaviour:**
- First press: cancel the current LLM/Tool call (return to prompt, session intact)
- Second press within 1 second: save session and exit gracefully
- Third press: force exit

**Session persistence contract:**

`tachu chat` uses the `FsMemorySystem` from `@tachu/extensions` by default. Each conversation is written to `<cwd>/.tachu/memory/<session-id>.jsonl` on every `append` (append-only for crash safety). `--resume` and `--session <id>` hydrate the full history from that file on startup, then the engine continues inside the very same `MemorySystem` — so the LLM sees the complete prior context.

- `persistence` is controlled via `memory.persistence` in `tachu.config.ts` (`"fs"` default / `"memory"` for SDK-embedded use)
- `persistDir` defaults to `.tachu/memory`
- `/history`, `/export <path>`, `/stats`, `/reset`, `/clear`, `/new`, `/load <id>` all operate against this single source of truth

---

### `tachu memory rebuild`

One-time lazy migration helper for projection outbox: scan historical `<persistDir>/*.jsonl` entries and enqueue any not yet tracked by the outbox (idempotent). Does **not** run embedding itself — `ProjectionWorker` handles actual vector upserts.

```
tachu memory rebuild [options]

Options:
  --session <id>           Process a single session only (default: scan all)
  --persist-dir <dir>      Memory jsonl root (default: .tachu/memory)
  --projection-dir <dir>   Projection outbox root (default: .tachu/projections)
  --no-color               Disable ANSI color output
  -h, --help               Show help
```

---

### `tachu approval`

Manage persistent tool-approval records stored as JSONL under `.tachu/approvals/` (project + user scope).

```
tachu approval <subcommand> [options]

Subcommands:
  list                     List approval records (--tool, --scope filters)
  revoke <id>              Revoke one record by ID
  revoke --tool <name> --all
                           Revoke all records for a tool
  clear                    Bulk delete (--expired, --scope, --tool filters)
  promote <id>             Promote a project-scoped record to user scope
  add                      Manually add a record (--tool, --kind any|shell|path, --pattern, --scope)
  export                   Dump all records as JSON to stdout
  import <file>            Import records from a JSON file
  -h, --help               Show help
```

---
