export const SOURCES = {
  codex: {
    label: "Codex (OpenAI CLI)",
    defaultPaths: () => [
      `${process.env.HOME}/.codex/sessions`,
    ],
    detect: () => exists(`${process.env.HOME}/.codex/sessions`),
  },
  opencode: {
    label: "OpenCode",
    defaultPaths: () => [
      `${process.env.HOME}/.local/share/opencode/opencode.db`,
    ],
    detect: () => exists(`${process.env.HOME}/.local/share/opencode/opencode.db`),
  },
  grok: {
    label: "Grok CLI",
    defaultPaths: () => [
      `${process.env.HOME}/.grok/sessions`,
    ],
    detect: () => exists(`${process.env.HOME}/.grok/sessions`),
  },
  t3: {
    label: "T3 Code",
    defaultPaths: () => [
      `${process.env.HOME}/.t3/userdata/state.sqlite`,
    ],
    detect: () => exists(`${process.env.HOME}/.t3/userdata/state.sqlite`),
  },
  synara: {
    label: "Synara",
    defaultPaths: () => [
      `${process.env.HOME}/.synara/userdata/state.sqlite`,
    ],
    detect: () => exists(`${process.env.HOME}/.synara/userdata/state.sqlite`),
  },
  claudecode: {
    label: "Claude Code",
    defaultPaths: () => [
      `${process.env.HOME}/.claude/projects`,
    ],
    detect: () => exists(`${process.env.HOME}/.claude/projects`),
  },
};

import { existsSync as exists } from "node:fs";
import path from "node:path";

export function resolvePath(source, override) {
  if (override) return path.resolve(override);
  const def = SOURCES[source];
  if (!def) throw new Error(`Unknown source: ${source}`);
  for (const p of def.defaultPaths()) {
    if (exists(p)) return p;
  }
  return def.defaultPaths()[0];
}

export function listAvailable() {
  return Object.entries(SOURCES)
    .filter(([, v]) => v.detect())
    .map(([k, v]) => ({ id: k, ...v }));
}
