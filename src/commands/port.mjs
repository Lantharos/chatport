import path from "node:path";
import fs from "node:fs/promises";
import { resolvePath, listAvailable, SOURCES } from "../lib/paths.mjs";
import { listSessionsFor, readSessionFor, TARGETS } from "../registry.mjs";
import { log, fatal } from "../lib/log.mjs";
import { withSpinner } from "../lib/spinner.mjs";
import { detectRunning } from "../lib/detect.mjs";
import { detectCompaction, applyCompaction, truncateToTurns } from "../lib/compaction.mjs";
import * as codexInject from "../injectors/codex.mjs";
import * as opencodeInject from "../injectors/opencode.mjs";
import * as grokInject from "../injectors/grok.mjs";
import * as t3Inject from "../injectors/t3.mjs";
import { toMarkdown } from "../injectors/markdown.mjs";
import { toClaudeMarkdown } from "../injectors/claude.mjs";
import { writeJson } from "../injectors/json.mjs";
import { deriveTitle, projectDisplay } from "../lib/title.mjs";

const NATIVE_TARGETS = ["codex", "opencode", "grok", "t3"];

export async function portCommand(opts) {
  const { from, to, session, fromPath, toPath, out, force, copy: isCopy, includeReasoning, dryRun, fullHistory, lastTurns, fromTurn, summaryOnly } = opts;

  if (!TARGETS.includes(to)) {
    fatal(`Unknown target: ${to}. Available: ${TARGETS.join(", ")}`);
  }

  const sourcePath = resolvePath(from, fromPath);
  const srcSession = await withSpinner(`Reading ${from} session from ${path.basename(sourcePath)}…`, () =>
    readSessionFor(from, { path: sourcePath, id: session }),
  );
  detectCompaction(srcSession);
  const fullMessageCount = srcSession.messages.length;

  const wantsFull = !!fullHistory;
  const keep = wantsFull ? "full" : (summaryOnly ? "summary-only" : "compacted");
  const isNative = NATIVE_TARGETS.includes(to);
  const applyTo = isNative ? keep : "full";

  if (applyTo !== "full") applyCompaction(srcSession, { keep: applyTo });
  if (typeof fromTurn === "number" || typeof lastTurns === "number") {
    truncateToTurns(srcSession, fromTurn, lastTurns);
  }

  const title = deriveTitle(srcSession);
  srcSession.title = title;
  const totalMsgs = srcSession.messages.length;
  const compactionNote = (srcSession.compaction?.applied && srcSession.compaction.applied !== "compacted")
    ? ` [${srcSession.compaction.applied}]`
    : "";
  const reductionNote = totalMsgs < fullMessageCount ? ` (was ${fullMessageCount})` : "";
  log.ok(`Loaded "${truncate(title, 70)}"  (${totalMsgs} messages${reductionNote}${compactionNote}${srcSession.cwd ? `, ${projectDisplay(srcSession.cwd)}` : ""})`);

  if (srcSession.compaction && srcSession.compaction.mode !== "none" && applyTo === "compacted") {
    const c = srcSession.compaction;
    if (c.mode === "codex") {
      log.dim(`  · detected ${c.count || 1} codex compaction(s); using last replacement_history (${c.replacement?.length || 0} items) + ${c.keptCount || 0} recent`);
    } else if (c.mode === "grok") {
      log.dim(`  · grok summary: ${c.summaryTurns} earlier turn(s) summarized + ${c.keptCount || 0} recent`);
    } else if (c.mode === "opencode" || c.mode === "t3") {
      log.dim(`  · ${c.mode} compacted session detected; using placeholder summary + ${c.keptCount || 0} recent`);
    }
  }

  if (dryRun) {
    log.warn("Dry run - showing summary only");
    printSummary(srcSession, to, fullMessageCount);
    return;
  }

  let result;
  if (to === "markdown") {
    const outFile = out || path.join(process.cwd(), `${slugify(title || srcSession.sessionId)}.md`);
    if (isCopy && !force && await exists(outFile)) fatal(`Output exists: ${outFile} (use --force to overwrite)`);
    const md = await withSpinner(`Writing markdown to ${path.basename(outFile)}…`, async () => {
      const m = toMarkdown(srcSession, { includeReasoning: !!includeReasoning });
      await fs.mkdir(path.dirname(outFile), { recursive: true });
      await fs.writeFile(outFile, m);
      return m;
    });
    result = { type: "file", path: outFile, bytes: md.length };
  } else if (to === "claude") {
    const outFile = out || path.join(process.cwd(), `${slugify(title || srcSession.sessionId)}.claude.md`);
    if (isCopy && !force && await exists(outFile)) fatal(`Output exists: ${outFile} (use --force to overwrite)`);
    const md = await withSpinner(`Writing Claude markdown…`, async () => {
      const m = toClaudeMarkdown(srcSession, { includeReasoning: !!includeReasoning });
      await fs.mkdir(path.dirname(outFile), { recursive: true });
      await fs.writeFile(outFile, m);
      return m;
    });
    result = { type: "file", path: outFile, bytes: md.length };
  } else if (to === "json") {
    const outFile = out || path.join(process.cwd(), `${slugify(title || srcSession.sessionId)}.ucf.json`);
    if (isCopy && !force && await exists(outFile)) fatal(`Output exists: ${outFile} (use --force to overwrite)`);
    await withSpinner(`Writing UCF JSON…`, () => writeJson(srcSession, outFile));
    result = { type: "file", path: outFile };
  } else if (to === "codex") {
    const target = out || path.join(resolvePath("codex"), "imported");
    const written = await withSpinner(`Writing Codex JSONL to ${target}…`, () => codexInject.writeCodex(srcSession, target));
    result = { type: "directory", path: written };
  } else if (to === "opencode") {
    const target = out || resolvePath("opencode");
    if (!force) {
      log.warn(`Writing to live OpenCode database. Pass --force to confirm.`);
      log.dim(`  target: ${target}`);
      fatal("Aborted. Re-run with --force to write to the live DB.");
    }
    if (await detectRunning("opencode")) {
      log.warn(`OpenCode is currently running. Imported sessions appear after you restart it.`);
    }
    const r = await withSpinner(`Writing to OpenCode database…`, () => opencodeInject.writeOpenCode(srcSession, target));
    result = { type: "session", path: target, id: r.sessionId, projectId: r.projectId, title: r.title };
  } else if (to === "grok") {
    const target = out || resolvePath("grok");
    const dir = await withSpinner(`Writing Grok session to ${target}…`, () => grokInject.writeGrok(srcSession, target));
    result = { type: "directory", path: dir };
  } else if (to === "t3") {
    const target = out || resolvePath("t3");
    if (!force) {
      log.warn(`Writing to live T3 Code database. Pass --force to confirm.`);
      log.dim(`  target: ${target}`);
      fatal("Aborted. Re-run with --force to write to the live DB.");
    }
    if (await detectRunning("t3")) {
      log.warn(`T3 Code is currently running. Imported threads appear after you reload or relaunch.`);
    }
    const r = await withSpinner(`Writing to T3 database…`, () => t3Inject.writeT3(srcSession, target));
    result = { type: "thread", path: target, id: r.threadId, projectId: r.projectId, title: r.title };
  }

  log.ok(`Done.`);
  if (result.path) log.kv("Output", result.path);
  if (result.id) log.kv("New ID", result.id);
  if (result.title) log.kv("Title", result.title);
  if (result.projectId) log.kv("Project ID", result.projectId);
  if (result.bytes) log.kv("Size", `${(result.bytes / 1024).toFixed(1)} KB`);

  if (isCopy) {
    log.dim(`(copy mode — source was not modified)`);
  }
}

function printSummary(session, to, fullCount) {
  log.kv("Title", session.title || session.sessionId);
  log.kv("Source", session.source);
  log.kv("Target format", to);
  log.kv("Messages", `${session.messages.length}${fullCount && fullCount > session.messages.length ? ` (compacted from ${fullCount})` : ""}`);
  if (session.compaction && session.compaction.mode !== "none") {
    const c = session.compaction;
    log.kv("Compaction", `${c.mode}${c.summaryTurns != null ? ` (${c.summaryTurns} earlier turns)` : ""}`);
  }
  const roleCounts = {};
  for (const m of session.messages) roleCounts[m.role] = (roleCounts[m.role] || 0) + 1;
  log.kv("Roles", Object.entries(roleCounts).map(([k, v]) => `${k}=${v}`).join(" "));
}

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

function slugify(s) {
  return String(s || "imported")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "imported";
}

function truncate(s, n) {
  if (!s) return "";
  if (s.length <= n) return s;
  return s.slice(0, n - 1).trimEnd() + "…";
}
