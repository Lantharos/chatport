import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { emptySession, makeBlock, makeMessage } from "../ucf.mjs";
import { deriveTitle } from "../lib/title.mjs";

function safeParse(line) {
  if (!line || !line.trim()) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function joinText(items) {
  if (!Array.isArray(items)) return "";
  return items
    .map((c) => {
      if (typeof c === "string") return c;
      if (!c) return "";
      if (c.type === "text" || c.type === "input_text" || c.type === "output_text") {
        return c.text || "";
      }
      if (c.type === "input_image" || c.type === "image") {
        return `[image: ${c.url || c.path || "attached"}]`;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function findJsonlFiles(root) {
  const out = [];
  function walk(dir) {
    let entries;
    try {
      entries = fsSync.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.startsWith("rollout-") && e.name.endsWith(".jsonl")) {
        out.push(p);
      }
    }
  }
  walk(root);
  return out.sort();
}

const ROLLOUT_TS_RE = /rollout-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})-/;

function rolloutTimestampFromName(filename) {
  const m = ROLLOUT_TS_RE.exec(filename);
  if (!m) return null;
  const isoish = m[1].replace(/-/g, (c, i) => (i < 10 ? c : ":")).replace("T", " ");
  return isoish;
}

export function cleanCodexTitle(filename, fallback) {
  const ts = rolloutTimestampFromName(filename);
  if (ts) return `Codex ${ts}`;
  return fallback || null;
}

const COMPACTION_RE = /"type":"compacted"/g;

async function countCompactions(file) {
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const pexec = promisify(execFile);
    const { stdout } = await pexec("grep", ["-c", "-m", "1000", '"type":"compacted"', file], { maxBuffer: 1024 * 64 });
    const n = parseInt((stdout || "0").trim(), 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

export async function listSessions(root) {
  const files = findJsonlFiles(root);
  const head = await Promise.all(
    files.map(async (file) => {
      try {
        const fh = await fs.open(file, "r");
        try {
          const buf = Buffer.alloc(64 * 1024);
          const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
          return { file, head: buf.slice(0, bytesRead).toString("utf-8") };
        } finally {
          await fh.close();
        }
      } catch {
        return { file, head: "" };
      }
    }),
  );
  const counts = await Promise.all(files.map((f) => countCompactions(f)));
  const out = [];
  for (let i = 0; i < files.length; i++) {
    try {
      const metaLine = head[i].head.split("\n").find((l) => l.includes('"session_meta"'));
      const meta = safeParse(metaLine);
      if (!meta) continue;
      const p = meta.payload || {};
      const baseName = path.basename(files[i], ".jsonl");
      out.push({
        id: p.id,
        title: p.title || cleanCodexTitle(baseName, baseName),
        cwd: p.cwd,
        model: p.model_provider,
        createdAt: p.timestamp,
        source: "codex",
        path: files[i],
        compactionEvents: counts[i] || 0,
      });
    } catch {}
  }
  return out.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
}

export async function readSession(filePath) {
  const raw = await fs.readFile(filePath, "utf-8");
  const lines = raw.split("\n");
  const session = emptySession({ source: "codex" });
  const toolCallsByCallId = new Map();

  let pendingToolResult = null;

  for (const line of lines) {
    const obj = safeParse(line);
    if (!obj) continue;

    if (obj.type === "session_meta") {
      const p = obj.payload || {};
      session.sessionId = p.id;
      session.title = p.title || null;
      session.cwd = p.cwd || null;
      session.model = p.model_provider || null;
      session.createdAt = p.timestamp || obj.timestamp || null;
      session.metadata.codex = {
        cliVersion: p.cli_version,
        originator: p.originator,
        source: p.source,
      };
      continue;
    }

    if (obj.type === "turn_context") {
      const p = obj.payload || {};
      if (p.model) session.metadata.codex = { ...(session.metadata.codex || {}), model: p.model };
      continue;
    }

    if (obj.type === "response_item") {
      const p = obj.payload || {};
      const ts = obj.timestamp ? Date.parse(obj.timestamp) : null;

      if (p.type === "message") {
        const role = p.role;
        const text = joinText(p.content);
        const blocks = (p.content || []).map((c) => {
          if (c.type === "input_text" || c.type === "output_text" || c.type === "text") {
            return makeBlock("text", { text: c.text || "" });
          }
          if (c.type === "input_image" || c.type === "image") {
            return makeBlock("file", { path: c.url || "image", content: "[image]" });
          }
          return makeBlock("text", { text: JSON.stringify(c) });
        });
        if (blocks.length === 0) blocks.push(makeBlock("text", { text }));
        session.messages.push(
          makeMessage({
            id: null,
            role,
            text,
            blocks,
            timestamp: ts,
            metadata: { phase: p.phase || null },
          }),
        );
        continue;
      }

      if (p.type === "function_call") {
        let parsedArgs = p.arguments;
        if (typeof parsedArgs === "string") {
          try { parsedArgs = JSON.parse(parsedArgs); } catch { parsedArgs = { raw: parsedArgs }; }
        }
        const block = makeBlock("tool_call", {
          tool: p.name,
          callId: p.call_id,
          args: parsedArgs,
          status: "completed",
        });
        toolCallsByCallId.set(p.call_id, { block, messageIndex: session.messages.length });
        const msg = makeMessage({
          role: "assistant",
          text: "",
          blocks: [block],
          timestamp: ts,
          toolCallId: p.call_id,
        });
        session.messages.push(msg);
        continue;
      }

      if (p.type === "function_call_output") {
        const out =
          typeof p.output === "string"
            ? p.output
            : p.output
              ? JSON.stringify(p.output)
              : "";
        const ref = toolCallsByCallId.get(p.call_id);
        if (ref) {
          ref.block.metadata = { ...(ref.block.metadata || {}), output: out };
          ref.block.status = "completed";
        }
        const msg = makeMessage({
          role: "tool",
          text: out,
          blocks: [makeBlock("tool_result", { toolCallId: p.call_id, text: out })],
          timestamp: ts,
          toolCallId: p.call_id,
        });
        session.messages.push(msg);
        continue;
      }

      if (p.type === "reasoning") {
        const text = (p.summary || []).map((s) => s.text || "").join("\n") || (p.text || "");
        const encrypted = p.encrypted_content || p.encrypted || null;
        session.messages.push(
          makeMessage({
            role: "assistant",
            text,
            blocks: [makeBlock("reasoning", { text, encrypted })],
            timestamp: ts,
            metadata: { reasoning: true, encrypted },
          }),
        );
        continue;
      }
    }

    if (obj.type === "compacted") {
      const p = obj.payload || {};
      session.messages.push(
        makeMessage({
          role: "system",
          text: p.message || "<compaction>",
          blocks: [makeBlock("text", { text: p.message || "<compaction>" })],
          timestamp: obj.timestamp ? Date.parse(obj.timestamp) : null,
          metadata: {
            kind: "compaction",
            replacementHistory: p.replacement_history || [],
            message: p.message || null,
          },
        }),
      );
      continue;
    }
  }

  if (!session.title) session.title = deriveTitle(session);
  return session;
}
