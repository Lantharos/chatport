#!/usr/bin/env node
import { Command } from "commander";
import { listCommand, infoCommand } from "./commands/list.mjs";
import { portCommand } from "./commands/port.mjs";
import { sourcesCommand } from "./commands/sources.mjs";
import { listSessionsFor, readSessionFor } from "./registry.mjs";
import { resolvePath, listAvailable } from "./lib/paths.mjs";
import { log, fatal } from "./lib/log.mjs";
import { deriveTitle, projectDisplay, pathShort } from "./lib/title.mjs";
import { withSpinner } from "./lib/spinner.mjs";
import * as showHelp from "./commands/help.mjs";
import { select, confirm, input, search } from "@inquirer/prompts";

const program = new Command();

program
  .name("chatport")
  .description("Move, copy, and convert chat history between AI CLI clients")
  .version("0.1.0");

program
  .command("sources")
  .description("Show which AI clients are detected on this machine")
  .action(() => sourcesCommand());

program
  .command("list <source>")
  .description("List sessions available from a source (codex, opencode, grok, t3, synara)")
  .option("-p, --path <path>", "Override the default data path")
  .option("--from-path <path>", "Alias for --path")
  .option("--project <name>", "Filter by project folder name")
  .option("--json", "Output as JSON")
  .action(async (source, opts) => {
    if (opts.fromPath) opts.path = opts.fromPath;
    try {
      await listCommand(source, opts);
    } catch (e) {
      fatal(e.message);
    }
  });

program
  .command("info <source> <session>")
  .description("Show details of a specific session")
  .option("-p, --path <path>", "Override the default data path")
  .option("--from-path <path>", "Alias for --path")
  .option("--json", "Output as JSON")
  .action(async (source, session, opts) => {
    if (opts.fromPath) opts.path = opts.fromPath;
    try {
      await infoCommand(source, session, opts);
    } catch (e) {
      fatal(e.message);
    }
  });

program
  .command("port")
  .description("Port a session from one client to another")
  .requiredOption("-f, --from <source>", "Source: codex, opencode, grok, t3, synara")
  .requiredOption("-t, --to <target>", "Target: codex, opencode, grok, t3, synara, markdown, json, claude")
  .requiredOption("-s, --session <id>", "Session ID or path")
  .option("--from-path <path>", "Override source data path")
  .option("--to-path <path>", "Override target data path")
  .option("-o, --out <path>", "Output file/directory")
  .option("--copy", "Copy mode (don't move original)")
  .option("--force", "Force write to live database (opencode, t3, synara)")
  .option("--reasoning", "Include assistant reasoning blocks in markdown export")
  .option("--dry-run", "Show what would be ported without writing")
  .option("--full-history", "Skip compaction: include all messages in native ports")
  .option("--summary-only", "Write only the compaction summary as a single system message")
  .option("--last-turns <n>", "Keep only the last N user turns (after compaction)")
  .option("--from-turn <n>", "Skip the first N user turns")
  .action(async (opts) => {
    if (opts.lastTurns != null) opts.lastTurns = Number(opts.lastTurns);
    if (opts.fromTurn != null) opts.fromTurn = Number(opts.fromTurn);
    try {
      await portCommand(opts);
    } catch (e) {
      fatal(e.message);
    }
  });

program
  .command("ui")
  .description("Interactive mode — pick source, session, target with prompts")
  .action(async () => {
    try {
      await interactive();
    } catch (e) {
      if (e?.message?.includes("User force closed")) process.exit(0);
      fatal(e.message);
    }
  });

program
  .command("doctor")
  .description("Diagnose data paths and parsers")
  .action(async () => {
    try {
      await doctor();
    } catch (e) {
      fatal(e.message);
    }
  });

async function interactive() {
  const avail = listAvailable();
  if (avail.length === 0) {
    fatal("No supported AI clients detected. Install one or use --from-path.");
  }
  const source = await select({
    message: "Pick a source:",
    choices: avail.map((a) => ({ name: `${a.id} — ${a.label}`, value: a.id })),
  });
  const path = resolvePath(source);

  const choice = await search({
    message: `Pick a session from ${source}  (type to filter):`,
    source: async (term) => {
      let sessions;
      try {
        sessions = await listSessionsFor(source, { path });
      } catch (e) {
        throw new Error(`Failed to load ${source} sessions: ${e.message}`);
      }
      const t = (term || "").toLowerCase();
      return sessions
        .filter((s) => {
          if (!t) return true;
          return (
            (s.title || "").toLowerCase().includes(t) ||
            (s.cwd || "").toLowerCase().includes(t) ||
            (s.id || "").toLowerCase().includes(t)
          );
        })
        .slice(0, 50)
        .map((s) => {
          const project = projectDisplay(s.cwd);
          const title = truncate(s.title || "(untitled)", 60);
          const meta = [
            project ? `📁 ${project}` : null,
            s.numChatMessages ? `${s.numChatMessages} msgs` : null,
            s.updatedAt ? formatTime(s.updatedAt) : s.createdAt ? formatTime(s.createdAt) : null,
          ].filter(Boolean).join("  ·  ");
          return {
            name: meta ? `${title}  —  ${chalkDim(meta)}` : title,
            value: s.id,
          };
        });
    },
  });
  const chosen = choice;
  const target = await select({
    message: "Pick a target format:",
    choices: [
      { name: "markdown — clean .md file (recommended)", value: "markdown" },
      { name: "claude — Claude conversation style", value: "claude" },
      { name: "json — UCF (chatport unified format)", value: "json" },
      ...(avail.filter((a) => a.id !== source).map((a) => ({ name: `${a.id} — native format (writes to ${a.label} store)`, value: a.id }))),
    ],
  });
  const isNative = ["codex", "opencode", "grok", "t3", "synara"].includes(target);
  let force = false;
  if (isNative) {
    force = await confirm({
      message: `This will write to your live ${target} data store. Continue?`,
      default: false,
    });
    if (!force) {
      log.warn("Aborted.");
      return;
    }
  }
  await portCommand({
    from: source,
    to: target,
    session: chosen,
    fromPath: path,
    force,
  });
}

async function doctor() {
  log.title("chatport doctor");
  const avail = listAvailable();
  log.kv("Detected", avail.map((a) => a.id).join(", ") || "(none)");
  for (const a of avail) {
    const path = resolvePath(a.id);
    try {
      const sessions = await listSessionsFor(a.id, { path });
      log.kv(a.id, `${sessions.length} sessions at ${path}`);
      const withMessages = sessions.find((s) => (s.numChatMessages || 0) > 1) || sessions[0];
      if (withMessages) {
        try {
          const s = await readSessionFor(a.id, { path, id: withMessages.id });
          log.dim(`  ✓ sample read: ${s.messages.length} messages from "${s.title || s.sessionId}"`);
        } catch (e) {
          log.err(`  ✗ sample read failed: ${e.message}`);
        }
      }
    } catch (e) {
      log.err(`  ✗ ${a.id}: ${e.message}`);
    }
  }
  console.log("");
  log.ok("Doctor complete.");
}

function truncate(s, n) {
  if (!s) return "";
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

function chalkDim(s) {
  const c = process.stdout.isTTY;
  return c ? `\x1b[2m${s}\x1b[0m` : s;
}

function formatTime(ts) {
  if (typeof ts === "number") {
    if (ts > 1e12) return new Date(ts).toISOString().replace("T", " ").slice(0, 19);
    return new Date(ts * 1000).toISOString().replace("T", " ").slice(0, 19);
  }
  return String(ts).replace("T", " ").slice(0, 19);
}

program.parseAsync(process.argv).catch((e) => {
  fatal(e?.message || String(e));
});
