export function showHelp() {
  console.log(`
chatport — Move chat history between AI CLI clients

USAGE
  chatport <command> [options]

COMMANDS
  sources                       List detected AI clients and their data paths
  list <source>                 List sessions from a source
  info <source> <session>       Show details of a single session
  port [opts]                   Port a session between sources/formats
  ui                            Interactive picker
  doctor                        Diagnose data paths and parsers

EXAMPLES
  chatport sources
  chatport list codex
  chatport info codex <session-id-or-path>
  chatport port -f codex -t markdown -s <session>
  chatport port -f opencode -t t3 -s <session-id> --force
  chatport port -f grok -t codex -s <session-uuid>
  chatport ui

PORT TARGETS
  markdown    Pretty .md with tool calls and reasoning
  claude      Claude-flavored <user>/<assistant> tags
  json        UCF (Unified Chat Format) JSON
  codex       Codex JSONL in ~/.codex/sessions
  opencode    OpenCode SQLite (requires --force for live DB)
  grok        Grok CLI session directories
  t3          T3 Code SQLite (requires --force for live DB)
  synara      Synara SQLite (requires --force for live DB)
  claudecode  Claude Code JSONL in ~/.claude/projects (best-effort; specify --out)

Use --reasoning to include assistant reasoning blocks in markdown export.
`);
}
