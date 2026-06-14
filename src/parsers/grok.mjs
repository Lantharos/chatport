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

function joinText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => {
      if (!c) return "";
      if (typeof c === "string") return c;
      if (c.type === "text") return c.text || "";
      if (c.type === "image" || c.type === "image_url") {
        return `[image: ${c.url || c.path || "attached"}]`;
      }
      return c.text || "";
    })
    .filter(Boolean)
    .join("\n");
}

function findSessionDirs(root) {
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
      if (e.isDirectory()) {
        if (e.name.startsWith("0") || e.name.includes("-")) {
          const ch = path.join(p, "chat_history.jsonl");
          if (fsSync.existsSync(ch)) {
            out.push(p);
            continue;
          }
        }
        walk(p);
      }
    }
  }
  walk(root);
  return out;
}

function getSummary(dir) {
  const f = path.join(dir, "summary.json");
  if (!fsSync.existsSync(f)) return null;
  try {
    return JSON.parse(fsSync.readFileSync(f, "utf-8"));
  } catch {
    return null;
  }
}

export async function listSessions(root) {
  const dirs = findSessionDirs(root);
  const out = [];
  for (const d of dirs) {
    const summary = getSummary(d);
    const id = summary?.info?.id || path.basename(d);
    const cwd = summary?.info?.cwd || null;
    let title = path.basename(d);
    try {
      const stat = await fs.stat(d);
      title = `${path.basename(path.dirname(d))}/${path.basename(d)}`;
    } catch {}
  out.push({
    id,
    title: title.slice(0, 80),
    cwd,
    model: summary?.current_model_id || null,
    createdAt: summary?.created_at || null,
    updatedAt: summary?.updated_at || null,
    numMessages: summary?.num_messages || 0,
    numChatMessages: summary?.num_chat_messages || 0,
    nextTraceTurn: summary?.next_trace_turn || 0,
    sessionSummary: summary?.session_summary || null,
    source: "grok",
    path: d,
  });
  }
  return out.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
}

export async function readSession(dirPath) {
  const summary = getSummary(dirPath);
  const session = emptySession({
    source: "grok",
    sessionId: summary?.info?.id || path.basename(dirPath),
    title: summary?.info?.cwd || path.basename(dirPath),
    cwd: summary?.info?.cwd || null,
    model: summary?.current_model_id || null,
    createdAt: summary?.created_at || null,
    updatedAt: summary?.updated_at || null,
  });
  session.metadata.grok = {
    agentName: summary?.agent_name || null,
    chatFormatVersion: summary?.chat_format_version || null,
    nextTraceTurn: summary?.next_trace_turn || 0,
    sessionSummary: summary?.session_summary || null,
    generatedTitle: summary?.generated_title || null,
    numMessages: summary?.num_messages || 0,
    numChatMessages: summary?.num_chat_messages || 0,
    gitRootDir: summary?.git_root_dir || null,
    headCommit: summary?.head_commit || null,
    headBranch: summary?.head_branch || null,
    grokHome: summary?.grok_home || null,
  };

  const ch = path.join(dirPath, "chat_history.jsonl");
  if (!fsSync.existsSync(ch)) return session;

  const raw = await fs.readFile(ch, "utf-8");
  const lines = raw.split("\n");

  const pendingToolResults = new Map();

  for (const line of lines) {
    const obj = safeParse(line);
    if (!obj) continue;

    if (obj.type === "system") {
      session.messages.push(
        makeMessage({
          role: "system",
          text: typeof obj.content === "string" ? obj.content : joinText(obj.content),
          blocks: [makeBlock("text", { text: typeof obj.content === "string" ? obj.content : joinText(obj.content) })],
          timestamp: obj.created_at ? Date.parse(obj.created_at) : null,
        }),
      );
      continue;
    }

    if (obj.type === "user") {
      const text = joinText(obj.content);
      session.messages.push(
        makeMessage({
          role: "user",
          text,
          blocks: [{ type: "text", text }],
          timestamp: obj.created_at ? Date.parse(obj.created_at) : null,
        }),
      );
      continue;
    }

    if (obj.type === "assistant") {
      const blocks = [];
      const reasoningText = obj.reasoning?.text || "";
      if (reasoningText) {
        blocks.push(makeBlock("reasoning", { text: reasoningText, encrypted: obj.reasoning?.encrypted || null }));
      }
      const contentText = obj.content || "";
      if (contentText) {
        blocks.push(makeBlock("text", { text: contentText }));
      }
      const toolCalls = obj.tool_calls || [];
      for (const tc of toolCalls) {
        let args = tc.arguments;
        if (typeof args === "string") {
          try { args = JSON.parse(args); } catch { /* leave as string */ }
        }
        blocks.push(
          makeBlock("tool_call", {
            tool: tc.name,
            callId: tc.id,
            args,
            status: "pending",
          }),
        );
        pendingToolResults.set(tc.id, true);
      }
      const allText = [contentText, reasoningText].filter(Boolean).join("\n");
      session.messages.push(
        makeMessage({
          role: "assistant",
          text: allText,
          blocks: blocks.length ? blocks : [makeBlock("text", { text: contentText })],
          timestamp: obj.created_at ? Date.parse(obj.created_at) : null,
          modelId: obj.model_id || null,
          metadata: {
            modelFingerprint: obj.model_fingerprint || null,
            encryptedReasoning: obj.reasoning?.encrypted || null,
          },
        }),
      );
      continue;
    }

    if (obj.type === "tool_result") {
      const out = typeof obj.content === "string" ? obj.content : joinText(obj.content);
      session.messages.push(
        makeMessage({
          role: "tool",
          text: out,
          blocks: [makeBlock("tool_result", { toolCallId: obj.tool_call_id, text: out })],
          timestamp: obj.created_at ? Date.parse(obj.created_at) : null,
          toolCallId: obj.tool_call_id,
        }),
      );
      continue;
    }
  }

  if (!session.title || session.title === session.sessionId) session.title = deriveTitle(session);
  return session;
}
