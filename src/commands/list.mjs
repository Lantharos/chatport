import { listSessionsFor, readSessionFor } from "../registry.mjs";
import { resolvePath } from "../lib/paths.mjs";
import { log } from "../lib/log.mjs";
import { withSpinner } from "../lib/spinner.mjs";
import { projectDisplay, pathShort } from "../lib/title.mjs";
import chalk from "chalk";

export async function listCommand(source, opts) {
  const path = resolvePath(source, opts.path);
  const sessions = await withSpinner(`Loading ${source} sessions…`, () => listSessionsFor(source, { path }));
  if (opts.json) {
    console.log(JSON.stringify(sessions, null, 2));
    return;
  }
  log.title(`${source} sessions (${sessions.length})`);
  if (sessions.length === 0) {
    log.dim("No sessions found.");
    return;
  }
  const filtered = opts.project
    ? sessions.filter((s) => s.cwd && (s.cwd === opts.project || s.cwd.includes(opts.project)))
    : sessions;
  if (filtered.length === 0) {
    log.dim(`No sessions match filter: ${opts.project}`);
    return;
  }
  const rows = filtered.map((s) => ({
    project: projectDisplay(s.cwd),
    title: truncate(s.title || "(untitled)", 50),
    id: truncate(s.id, 36),
    model: truncate(s.model || "", 24),
    msgs: s.numChatMessages ?? "",
    compact: s.compactionEvents > 0 ? `×${s.compactionEvents}` : (s.nextTraceTurn > 0 ? `t${s.nextTraceTurn}` : ""),
    updated: s.updatedAt ? formatTime(s.updatedAt) : s.createdAt ? formatTime(s.createdAt) : "",
  }));
  printTable(rows, ["project", "title", "id", "model", "msgs", "compact", "updated"]);
}

export async function infoCommand(source, idOrPath, opts) {
  const path = resolvePath(source, opts.path);
  const session = await withSpinner(`Reading ${source} session…`, () =>
    readSessionFor(source, { path, id: idOrPath }),
  );
  const { detectCompaction } = await import("../lib/compaction.mjs");
  detectCompaction(session);
  if (opts.json) {
    console.log(JSON.stringify(session, null, 2));
    return;
  }
  log.title(`Session: ${session.title || session.sessionId}`);
  log.kv("Source", session.source);
  log.kv("ID", session.sessionId);
  log.kv("Model", session.model || "-");
  log.kv("Project", session.cwd ? `${projectDisplay(session.cwd)}  ${chalk.gray(pathShort(session.cwd, 60))}` : "-");
  log.kv("Created", session.createdAt ? formatTime(session.createdAt) : "-");
  log.kv("Messages", session.messages.length);
  const roleCounts = {};
  const blockCounts = {};
  for (const m of session.messages) {
    roleCounts[m.role] = (roleCounts[m.role] || 0) + 1;
    for (const b of m.blocks || []) {
      blockCounts[b.type] = (blockCounts[b.type] || 0) + 1;
    }
  }
  log.kv("Roles", Object.entries(roleCounts).map(([k, v]) => `${k}=${v}`).join(" "));
  log.kv("Blocks", Object.entries(blockCounts).map(([k, v]) => `${k}=${v}`).join(" "));
  if (session.compaction && session.compaction.mode !== "none") {
    const c = session.compaction;
    const detail = c.mode === "codex"
      ? `${c.count} compaction(s); ${c.replacement?.length || 0} summary items + ${session.messages.length - c.cutIndex} recent`
      : c.mode === "grok"
        ? `${c.summaryTurns || 0} earlier turn(s) summarized; ${session.messages.length - c.cutIndex} recent kept`
        : `${c.mode} compaction detected`;
    log.kv("Compaction", detail);
  }
  console.log("");
  log.dim("First user message:");
  const first = session.messages.find((m) => m.role === "user");
  if (first) {
    const txt = (first.text || "").slice(0, 300);
    console.log("  " + chalk.gray(txt + (first.text && first.text.length > 300 ? "..." : "")));
  }
}

function truncate(s, n) {
  if (!s) return "";
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

function formatTime(ts) {
  if (typeof ts === "number") {
    if (ts > 1e12) return new Date(ts).toISOString().replace("T", " ").slice(0, 19);
    return new Date(ts * 1000).toISOString().replace("T", " ").slice(0, 19);
  }
  return String(ts).replace("T", " ").slice(0, 19);
}

function printTable(rows, cols) {
  if (rows.length === 0) return;
  cols = cols || Object.keys(rows[0]);
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length)));
  const useColor = process.stdout.isTTY;
  const header = cols.map((c, i) => (useColor ? chalk.bold(c.padEnd(widths[i])) : c.padEnd(widths[i]))).join("  ");
  console.log(header);
  console.log(cols.map((_, i) => "-".repeat(widths[i])).join("  "));
  for (const r of rows) {
    console.log(
      cols
        .map((c, i) => String(r[c] ?? "").padEnd(widths[i]))
        .join("  "),
    );
  }
}
