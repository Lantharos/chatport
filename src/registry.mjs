import * as codex from "./parsers/codex.mjs";
import * as opencode from "./parsers/opencode.mjs";
import * as grok from "./parsers/grok.mjs";
import * as t3 from "./parsers/t3.mjs";
import * as synara from "./parsers/synara.mjs";
import * as claudecode from "./parsers/claudecode.mjs";

export const PARSERS = { codex, opencode, grok, t3, synara, claudecode };

export const TARGETS = ["codex", "opencode", "grok", "t3", "synara", "claudecode", "markdown", "json", "claude"];

export function getParser(source) {
  const p = PARSERS[source];
  if (!p) throw new Error(`Unknown source: ${source}. Available: ${Object.keys(PARSERS).join(", ")}`);
  return p;
}

export async function listSessionsFor(source, opts = {}) {
  const p = getParser(source);
  const root = opts.path;
  if (source === "codex") return p.listSessions(root);
  if (source === "opencode") return p.listSessions(root);
  if (source === "grok") return p.listSessions(root);
  if (source === "t3") return p.listThreads(root);
  if (source === "synara") return p.listThreads(root);
  if (source === "claudecode") return p.listSessions(root);
  throw new Error(`listSessions not supported for ${source}`);
}

export async function findSessionById(source, path, id) {
  const all = await listSessionsFor(source, { path });
  const found = all.find((s) => s.id === id || s.id?.startsWith(id) || s.path === id);
  if (!found) throw new Error(`Session not found: ${id}`);
  return found;
}

export async function readSessionFor(source, opts) {
  const { path, id } = opts;
  const p = getParser(source);
  if (source === "codex") {
    let filePath = id;
    if (!filePath?.endsWith(".jsonl")) {
      const found = await findSessionById(source, path, id);
      filePath = found.path;
    }
    return p.readSession(filePath);
  }
  if (source === "opencode") return p.readSession(path, id);
  if (source === "grok") {
    let dirPath = id;
    if (!dirPath?.includes("/") || !dirPath.endsWith("system_prompt.txt") && !dirPath.includes("chat_history.jsonl")) {
      const found = await findSessionById(source, path, id);
      dirPath = found.path;
    }
    return p.readSession(dirPath);
  }
  if (source === "t3") return p.readThread(path, id);
  if (source === "synara") return p.readThread(path, id);
  if (source === "claudecode") {
    let filePath = id;
    if (!filePath?.endsWith(".jsonl")) {
      const found = await findSessionById(source, path, id);
      filePath = found.path;
    }
    return p.readSession(filePath);
  }
  throw new Error(`readSession not supported for ${source}`);
}
