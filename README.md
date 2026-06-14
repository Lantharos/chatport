# chatport

> Move, copy, and convert chat history between AI coding CLIs.

`chatport` is a single CLI that reads chat sessions from one AI client and writes them to another — or to portable formats (Markdown, JSON, Claude-flavored) you can paste anywhere.

```
codex  ⇄  opencode  ⇄  grok  ⇄  t3  ⇄  synara
  ↓       ↓           ↓      ↓      ↓
       markdown / json / claude
```

## Supported sources

| Source   | Where it stores data                          |
| -------- | --------------------------------------------- |
| `codex`  | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` |
| `opencode` | `~/.local/share/opencode/opencode.db` (SQLite) |
| `grok`   | `~/.grok/sessions/<encoded-cwd>/<uuid>/`      |
| `t3`     | `~/.t3/userdata/state.sqlite` (SQLite)        |
| `synara` | `~/.synara/userdata/state.sqlite` (SQLite)    |

## Install

```bash
git clone https://github.com/you/chatport
cd chatport
npm install
npm link              # makes `chatport` available globally
```

Or once published:

```bash
npm install -g chatport
```

## Quick start

```bash
# What AI clients are installed?
chatport sources

# List every Codex session on this machine
chatport list codex

# Inspect a specific session
chatport info codex 019ec2ba-53a6-7512-9b6b-ec9067405151

# Port a session to markdown (works for any source)
chatport port -f codex -t markdown -s 019ec2ba-53a6-7512-9b6b-ec9067405151 \
  -o ./my-chat.md

# Port a Grok session into OpenCode's SQLite
chatport port -f grok -t opencode -s 019e7533-...  --force

# Port a Codex session into T3 Code (live database)
chatport port -f codex -t t3 -s 019ec2ba-...      --force

# Port a Codex session into Synara (live database)
chatport port -f codex -t synara -s 019ec2ba-...  --force

# Interactive picker — pick source / session / target with arrows
chatport ui
```

## Commands

| Command                | Description                                  |
| ---------------------- | -------------------------------------------- |
| `chatport sources`     | List detected AI clients + their data paths |
| `chatport list <src>`  | List sessions in a source                    |
| `chatport info <src> <id>` | Show details of a single session         |
| `chatport port`        | Move/copy a session to another target        |
| `chatport ui`          | Interactive picker                           |
| `chatport doctor`      | Diagnose data paths and parsers              |

## `port` flags

```
-f, --from <source>     codex, opencode, grok, t3, synara
-t, --to <target>       codex, opencode, grok, t3, synara, markdown, json, claude
-s, --session <id>      Session ID (from `list`)
    --from-path <path>  Override source data path
    --to-path   <path>  Override target data path
-o, --out <path>        Output file/directory
    --copy              Copy mode (don't move original)
    --force             Required to write to live OpenCode/T3/Synara databases
    --reasoning         Include assistant reasoning blocks in markdown
    --dry-run           Show what would be ported without writing
```

## Output formats

### `markdown` (default for humans)
Pretty, human-readable. Tool calls, results, and reasoning are all inlined with proper code fences. Use this when you want to read or share a session.

### `claude`
Flavored for Anthropic Claude — uses `<user>`, `<assistant>`, `<system>`, and `<tool_use>` / `<tool_result>` tags.

### `json` (UCF)
The native `chatport` format. Round-trip safe. Use this if you want lossless conversion or are building a pipeline.

### `codex` / `opencode` / `grok` / `t3` / `synara`
Native formats written to the target client's storage layout. Useful for:
- Migrating a conversation from one tool to another
- Resuming a long session in a different client

These require the **target** to be installed. Writing to a **live database** (OpenCode, T3, Synara) requires `--force`.

## How it works

```
┌────────────┐    parse    ┌──────────────┐    emit     ┌────────────┐
│ codex JSONL│ ──────────▶ │              │ ──────────▶ │ opencode.db│
│ opencode.db│ ──────────▶ │ UCF (UCF v1) │ ──────────▶ │ grok dirs  │
│ grok dirs  │ ──────────▶ │              │ ──────────▶ │ t3 sqlite  │
│ t3 sqlite  │ ──────────▶ │              │ ──────────▶ │ synara.sqlite│
│ synara db  │ ──────────▶ │              │ ──────────▶ │ *.md / *.json │
└────────────┘             └──────────────┘             └────────────┘
```

The Unified Chat Format (UCF) is the canonical intermediate representation:

```json
{
  "version": 1,
  "source": "codex",
  "sessionId": "019ec2ba-...",
  "title": "Refactor wgpu renderer",
  "model": "openai",
  "cwd": "/home/.../opencraft",
  "messages": [
    {
      "role": "user",
      "text": "Create a Rust project using wgpu and winit.",
      "blocks": [{ "type": "text", "text": "..." }],
      "timestamp": 1778082056000
    },
    {
      "role": "assistant",
      "text": "I will first inspect the repository shape.",
      "blocks": [
        { "type": "text", "text": "..." },
        { "type": "tool_call", "tool": "exec_command", "args": {"cmd": "ls"} }
      ]
    }
  ]
}
```

Block types: `text`, `reasoning`, `tool_call`, `tool_result`, `file`.

## Title derivation example

Source: Codex session with no title, first user message starts with `<INSTRUCTIONS>...</INSTRUCTIONS>` boilerplate.

Derived title: `Create a Rust project using wgpu and winit.`

## Notes & limitations

- **Tool fidelity:** Chatports are best-effort. Tool calls are translated to the closest equivalent in the target format. Some metadata (file paths, exit codes, content snippets) may be simplified.
- **Live databases are dangerous.** `chatport port -t opencode` / `-t t3` / `-t synara` writes to the actual SQLite file. If the client is running, you may need to close it first or the database may be locked. We refuse to write without `--force`.
- **Live server caching:** OpenCode, T3 Code and Synara cache session data in memory. After importing, the opencode/t3/synara server may need to be restarted (or the app reloaded) to see the new session. `chatport` warns you when it detects a running server.
- **Project linking:** Imported sessions are linked to a project by computing the same SHA-1 ID OpenCode uses (`git-remote:<url>` or `<worktree-path>`). If the source session has a `cwd` inside a git repo, the imported session will appear in the matching project. Sessions from non-git directories fall into OpenCode's "global" project.
- **Title derivation:** When a source lacks a title (most do), `chatport` derives one from the first user message — stripping out `<system-reminder>`, `<INSTRUCTIONS>`, code blocks, and `@mentions` so the title is human-readable. Codex sessions with no real title are shown as `Codex 2026-06-13 22:44:11` instead of the raw `rollout-...` filename.
- **Compaction handling:** Long sessions are compacted by their source client. By default, when porting to a **native** target (`codex`, `opencode`, `grok`, `t3`, `synara`), chatport keeps the most recent messages and replaces earlier turns with the client's existing summary (or a placeholder if no summary text is available). Markdown / JSON exports always keep the **full** history. Override with:
  - `--full-history` — skip compaction, keep everything
  - `--summary-only` — write only the compaction summary
  - `--last-turns <n>` — keep only the last N user turns
  - `--from-turn <n>` — skip the first N user turns
- **T3 Code messages** are stored as text in `projection_thread_messages`, with tool calls in `projection_thread_activities`. Chatport merges both.
- **Synara** uses the same `projection_*` tables as T3 Code but evolved the schema: `projection_threads.model` was replaced by `model_selection_json` (canonical `{provider, model}`), and many new columns were added across migrations 16–42 (e.g. `runtime_mode`, `interaction_mode`, `env_mode`, `archived_at`, `parent_thread_id`, `is_pinned`). The Synara parser/injector introspects the schema with `pragma_table_info` and only touches columns that actually exist, so it works on both freshly-installed Synara DBs and older imports.
- **OpenCode parts** support `text`, `reasoning`, `file`, and `tool`. Custom step types are skipped.

## Spinners & UX

Blocking actions in the **CLI** show a `⠋⠙⠸⠴⠦⠧⠇⠏` spinner. In non-TTY (CI, pipes) the same steps show as `· text` lines.

The interactive `chatport ui` picker uses a simple `· Loading <source> sessions…` log line followed by the prompt — the animated spinner conflicts with `@inquirer/prompts`' screen rendering, so we keep it readable without animation.

The `list` and `info` commands show the **project** (folder basename) as a first-class column. Use `--project <name>` to filter:

```bash
chatport list codex --project blur-my-shell
```

The `list` command also shows a `compact` column with `×N` for codex sessions that have been compacted N times, or `tN` for grok sessions that have N earlier summarized turns.

The interactive `chatport ui` picker shows project · msg count · date alongside the title and supports live filtering.

## Development

```bash
npm install
npm test
npm link                 # install globally
node bin/chatport.mjs --help
```

## License

MIT
