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

function decodeProjectKey(name) {
  if (!name) return null;
  return "/" + String(name).replace(/^-+/, "").replace(/-/g, "/");
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
      else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
    }
  }
  walk(root);
  return out.sort();
}

function joinContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => {
      if (typeof c === "string") return c;
      if (!c) return "";
      if (c.type === "text" && c.text) return c.text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function extractToolCalls(content) {
  if (!Array.isArray(content)) return [];
  return content
    .filter((c) => c && c.type === "tool_use")
    .map((c) => ({ id: c.id, name: c.name, input: c.input }));
}

function extractToolResults(content) {
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const c of content) {
    if (!c) continue;
    if (c.type === "tool_result") {
      out.push({
        tool_use_id: c.tool_use_id,
        content: c.content,
        is_error: c.is_error,
      });
    }
  }
  return out;
}

function extractThinking(content) {
  if (!Array.isArray(content)) return [];
  return content
    .filter((c) => c && c.type === "thinking" && c.thinking)
    .map((c) => c.thinking);
}

function parseTimestamp(ts) {
  if (!ts) return null;
  const n = Date.parse(ts);
  return Number.isFinite(n) ? n : null;
}

function readJsonlFile(filePath) {
  let raw;
  try {
    raw = fsSync.readFileSync(filePath, "utf-8");
  } catch {
    return [];
  }
  return raw.split("\n").map(safeParse).filter(Boolean);
}

function dedupeStreamingChunks(entries) {
  const groups = new Map();
  const singles = [];
  for (const e of entries) {
    if (e.type === "assistant" && (e.requestId || e.message?.id)) {
      const key = `${e.requestId || ""}|${e.message?.id || ""}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(e);
    } else {
      singles.push(e);
    }
  }
  const merged = [];
  for (const list of groups.values()) {
    if (list.length === 1) {
      merged.push(list[0]);
      continue;
    }
    list.sort((a, b) => {
      const ta = a.timestamp ? Date.parse(a.timestamp) : 0;
      const tb = b.timestamp ? Date.parse(b.timestamp) : 0;
      return ta - tb;
    });
    const withStopReason = list.find((e) => e.message?.stop_reason != null);
    merged.push(withStopReason || list[list.length - 1]);
  }
  return [...singles, ...merged];
}

function findSubagentFiles(sessionDir) {
  const subDir = path.join(sessionDir, "subagents");
  let entries;
  try {
    entries = fsSync.readdirSync(subDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.startsWith("agent-") && e.name.endsWith(".jsonl"))
    .map((e) => {
      const m = e.name.match(/^agent-(.+)\.jsonl$/);
      return { file: path.join(subDir, e.name), agentId: m ? m[1] : null };
    });
}

function readSubagentMeta(metaFile) {
  try {
    return JSON.parse(fsSync.readFileSync(metaFile, "utf-8"));
  } catch {
    return null;
  }
}

export function listSessions(root) {
  if (!root) return [];
  const files = findJsonlFiles(root);
  const out = [];
  for (const file of files) {
    try {
      const fh = fsSync.openSync(file, "r");
      try {
        const buf = Buffer.alloc(64 * 1024);
        const bytesRead = fsSync.readSync(fh, buf, 0, buf.length, 0);
        const head = buf.slice(0, bytesRead).toString("utf-8");
        const projectDir = path.basename(path.dirname(file));
        const projectCwd = decodeProjectKey(projectDir);
        const firstUserLine = head
          .split("\n")
          .map((l) => safeParse(l))
          .find((o) => o && o.type === "user" && !o.isMeta);
        const first = firstUserLine ? joinContent(firstUserLine.message?.content).slice(0, 80) : null;
        const sessionId = (head.match(/"sessionId"\s*:\s*"([^"]+)"/) || [, null])[1];
        const tsMatch = head.match(/"timestamp"\s*:\s*"([^"]+)"/);
        const createdAt = tsMatch ? tsMatch[1] : null;
        const titleMatch = head.match(/"type"\s*:\s*"(?:custom-title|agent-name)"[\s\S]*?"(?:customTitle|agentName)"\s*:\s*"([^"]+)"/);
        const title = titleMatch ? titleMatch[1] : (first || null);
        out.push({
          id: sessionId || path.basename(file, ".jsonl"),
          title,
          cwd: projectCwd,
          createdAt,
          source: "claudecode",
          path: file,
        });
      } finally {
        fsSync.closeSync(fh);
      }
    } catch {}
  }
  return out.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
}

function resolveExternalizedContent(content, toolResultsDir, toolUseId) {
  if (typeof content !== "string") return content;
  if (!content.endsWith(".json") && !content.includes("/")) return content;
  const candidates = [
    path.isAbsolute(content) ? content : null,
    path.join(toolResultsDir, `${toolUseId}.json`),
    path.join(toolResultsDir, content),
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      const raw = fsSync.readFileSync(c, "utf-8");
      const parsed = JSON.parse(raw);
      if (typeof parsed === "string") return parsed;
      if (parsed && typeof parsed === "object" && "content" in parsed) return parsed.content;
      return parsed;
    } catch {}
  }
  return content;
}

function buildMessageForEntry(obj, session, skippedCounts, toolResultsDir) {
  const ts = parseTimestamp(obj.timestamp);
  const m = obj.message || {};

  if (obj.type === "user") {
    if (obj.isMeta) return null;
    const content = m.content;
    const text = joinContent(content);
    const blocks = [];
    if (Array.isArray(content)) {
      for (const c of content) {
        if (!c) continue;
        if (c.type === "text" && c.text) blocks.push(makeBlock("text", { text: c.text }));
        else if (c.type === "tool_result") {
          const body = resolveExternalizedContent(c.content, toolResultsDir, c.tool_use_id);
          blocks.push(
            makeBlock("tool_result", {
              toolCallId: c.tool_use_id,
              text: typeof body === "string" ? body : JSON.stringify(body || ""),
              isError: !!c.is_error,
              externalized: typeof c.content === "string" && (c.content.endsWith(".json") || c.content.includes("/")),
            }),
          );
        }
      }
    }
    if (blocks.length === 0) blocks.push(makeBlock("text", { text }));
    return makeMessage({
      role: "user",
      text,
      blocks,
      timestamp: ts,
      metadata: {
        parentUuid: obj.parentUuid || null,
        sourceToolAssistantUUID: obj.sourceToolAssistantUUID || null,
        permissionMode: obj.permissionMode || null,
        promptId: obj.promptId || null,
        gitBranch: obj.gitBranch || null,
        version: obj.version || null,
      },
    });
  }

  if (obj.type === "assistant") {
    const content = m.content || [];
    if (m.model && !session.model) session.model = m.model;
    const text = joinContent(content);
    const blocks = [];
    for (const t of extractThinking(content)) blocks.push(makeBlock("reasoning", { text: t }));
    for (const c of content) {
      if (!c) continue;
      if (c.type === "text" && c.text) blocks.push(makeBlock("text", { text: c.text }));
    }
    for (const tc of extractToolCalls(content)) {
      blocks.push(
        makeBlock("tool_call", {
          tool: tc.name,
          callId: tc.id,
          args: tc.input || {},
          status: "completed",
        }),
      );
    }
    for (const tr of extractToolResults(content)) {
      const body = resolveExternalizedContent(tr.content, toolResultsDir, tr.tool_use_id);
      blocks.push(
        makeBlock("tool_result", {
          toolCallId: tr.tool_use_id,
          text: typeof body === "string" ? body : JSON.stringify(body || ""),
          isError: !!tr.is_error,
          externalized: typeof tr.content === "string" && (tr.content.endsWith(".json") || tr.content.includes("/")),
        }),
      );
    }
    if (blocks.length === 0) blocks.push(makeBlock("text", { text }));
    return makeMessage({
      role: "assistant",
      text,
      blocks,
      timestamp: ts,
      modelId: m.model || null,
      metadata: {
        stopReason: m.stop_reason || null,
        requestId: obj.requestId || null,
        messageId: m.id || null,
        parentUuid: obj.parentUuid || null,
        gitBranch: obj.gitBranch || null,
        version: obj.version || null,
        usage: m.usage || null,
      },
    });
  }

  if (obj.type === "system") {
    const text = typeof m.content === "string" ? m.content : joinContent(m.content);
    return makeMessage({
      role: "system",
      text,
      blocks: [makeBlock("text", { text })],
      timestamp: ts,
      metadata: { subtype: obj.subtype || null, level: obj.level || null, parentUuid: obj.parentUuid || null },
    });
  }

  if (obj.type === "progress") {
    const prompt = obj.data?.prompt || null;
    const agentId = obj.data?.agentId || null;
    const text = prompt ? `[subagent: ${agentId || "?"}] ${prompt.slice(0, 120)}` : `[subagent progress]`;
    return makeMessage({
      role: "system",
      text,
      blocks: [makeBlock("text", { text })],
      timestamp: ts,
      metadata: {
        kind: "subagent-progress",
        agentId,
        parentToolUseID: obj.parentToolUseID || null,
        toolUseID: obj.toolUseID || null,
        prompt,
        parentUuid: obj.parentUuid || null,
      },
    });
  }

  return null;
}

function readMainEntries(filePath) {
  return readJsonlFile(filePath);
}

export function readSession(filePath) {
  const session = emptySession({ source: "claudecode" });
  const rawEntries = readMainEntries(filePath);
  const sessionDir = path.join(path.dirname(filePath), path.basename(filePath, ".jsonl"));
  const toolResultsDir = path.join(sessionDir, "tool-results");
  const entries = dedupeStreamingChunks(rawEntries);

  const skippedCounts = {
    progress: 0,
    fileHistorySnapshot: 0,
    queueOperation: 0,
    attachment: 0,
    permissionMode: 0,
    lastPrompt: 0,
    customTitle: 0,
    agentName: 0,
  };
  const subagentSummaries = [];
  let modelId = null;
  let slug = null;
  let requestIdCount = 0;

  for (const obj of entries) {
    if (!session.sessionId && obj.sessionId) session.sessionId = obj.sessionId;
    if (obj.cwd && !session.cwd) session.cwd = obj.cwd;
    if (obj.slug && !slug) slug = obj.slug;
    if (obj.requestId) requestIdCount++;

    if (obj.type === "custom-title") { skippedCounts.customTitle++; if (obj.customTitle && !session.title) session.title = obj.customTitle; continue; }
    if (obj.type === "agent-name") { skippedCounts.agentName++; if (obj.agentName && !session.title) session.title = obj.agentName; continue; }
    if (obj.type === "last-prompt") {
      skippedCounts.lastPrompt++;
      if (obj.lastPrompt) session.metadata.claudecode = { ...(session.metadata.claudecode || {}), lastPrompt: obj.lastPrompt };
      continue;
    }
    if (obj.type === "permission-mode") {
      skippedCounts.permissionMode++;
      session.metadata.claudecode = { ...(session.metadata.claudecode || {}), permissionMode: obj.permissionMode };
      continue;
    }
    if (obj.type === "file-history-snapshot") { skippedCounts.fileHistorySnapshot++; continue; }
    if (obj.type === "queue-operation") { skippedCounts.queueOperation++; continue; }
    if (obj.type === "attachment") { skippedCounts.attachment++; continue; }

    if (obj.type === "progress") {
      skippedCounts.progress++;
      const msg = buildMessageForEntry(obj, session, skippedCounts, toolResultsDir);
      if (msg) session.messages.push(msg);
      continue;
    }
    if (obj.type === "system") {
      skippedCounts.system = (skippedCounts.system || 0) + 1;
      const msg = buildMessageForEntry(obj, session, skippedCounts, toolResultsDir);
      if (msg) session.messages.push(msg);
      continue;
    }

    if (obj.type === "user" || obj.type === "assistant") {
      const msg = buildMessageForEntry(obj, session, skippedCounts, toolResultsDir);
      if (msg) {
        if (msg.role === "assistant" && msg.modelId && !modelId) modelId = msg.modelId;
        session.messages.push(msg);
      }
    }
  }

  const subagentFiles = findSubagentFiles(sessionDir);
  for (const { file: subFile, agentId } of subagentFiles) {
    const subEntries = readJsonlFile(subFile);
    const subMeta = readSubagentMeta(path.join(sessionDir, "subagents", `agent-${agentId}.meta.json`));
    const subDeduped = dedupeStreamingChunks(subEntries);
    let subCount = 0;
    let subModel = null;
    for (const obj of subDeduped) {
      if (obj.type !== "user" && obj.type !== "assistant" && obj.type !== "system" && obj.type !== "progress") continue;
      const msg = buildMessageForEntry(obj, session, skippedCounts, toolResultsDir);
      if (!msg) continue;
      msg.metadata = {
        ...(msg.metadata || {}),
        subagent: true,
        agentId,
        parentToolUseID: null,
      };
      const parentToolUseMatch = subEntries.find((e) => e.type === "user" && e.message?.content?.some?.((c) => c.type === "tool_result" && c.tool_use_id));
      const promptMatch = subEntries.find((e) => e.type === "user" && !e.isMeta);
      if (promptMatch) {
        const pt = joinContent(promptMatch.message?.content);
        if (pt) msg.metadata.subagentPrompt = pt;
      }
      if (msg.modelId && !subModel) subModel = msg.modelId;
      subCount++;
      session.messages.push(msg);
    }
    subagentSummaries.push({
      agentId,
      file: subFile,
      entryCount: subCount,
      model: subModel,
      agentType: subMeta?.agentType || null,
      description: subMeta?.description || null,
    });
  }

  session.messages.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

  if (modelId && !session.model) session.model = modelId;
  if (slug) session.metadata.claudecode = { ...(session.metadata.claudecode || {}), slug };
  session.metadata.claudecode = {
    ...(session.metadata.claudecode || {}),
    skipped: skippedCounts,
    streaming: {
      uniqueRequestIds: requestIdCount,
      note: requestIdCount > 0 ? "Assistant entries with the same requestId/messageId were collapsed; only the final chunk (with stop_reason) was kept" : null,
    },
    subagents: subagentSummaries,
  };
  if (!session.title) session.title = deriveTitle(session);
  return session;
}
