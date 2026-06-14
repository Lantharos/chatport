export const UCF_VERSION = 1;

export const ROLES = ["system", "user", "assistant", "tool", "developer"];

export const BLOCK_TYPES = [
  "text",
  "reasoning",
  "tool_call",
  "tool_result",
  "file",
];

export function emptySession(meta = {}) {
  return {
    version: UCF_VERSION,
    source: meta.source || null,
    sessionId: meta.sessionId || null,
    title: meta.title || null,
    model: meta.model || null,
    cwd: meta.cwd || null,
    createdAt: meta.createdAt || null,
    updatedAt: meta.updatedAt || null,
    messages: [],
    compaction: { mode: "none" },
    metadata: meta.metadata || {},
  };
}

export function userMessage(text, opts = {}) {
  return makeMessage({ role: "user", text, ...opts });
}

export function assistantMessage(text, opts = {}) {
  return makeMessage({ role: "assistant", text, ...opts });
}

export function systemMessage(text, opts = {}) {
  return makeMessage({ role: "system", text, ...opts });
}

export function toolMessage(text, opts = {}) {
  return makeMessage({ role: "tool", text, ...opts });
}

export function makeMessage({
  role,
  text = "",
  blocks = null,
  id = null,
  timestamp = null,
  modelId = null,
  toolCallId = null,
  metadata = null,
}) {
  if (!ROLES.includes(role)) {
    throw new Error(`Invalid role: ${role}`);
  }
  return {
    id: id || null,
    role,
    text,
    blocks: blocks || [{ type: "text", text }],
    timestamp: timestamp || null,
    modelId: modelId || null,
    toolCallId: toolCallId || null,
    metadata: metadata || {},
  };
}

export function makeBlock(type, data) {
  if (!BLOCK_TYPES.includes(type)) {
    throw new Error(`Invalid block type: ${type}`);
  }
  return { type, ...data };
}

export function textOf(blocks) {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .filter((b) => b && (b.type === "text" || b.type === "reasoning"))
    .map((b) => b.text || "")
    .join("\n")
    .trim();
}

export function summarize(session) {
  const counts = { user: 0, assistant: 0, system: 0, tool: 0 };
  let toolCalls = 0;
  for (const m of session.messages) {
    if (counts[m.role] !== undefined) counts[m.role]++;
    if (m.blocks) {
      for (const b of m.blocks) {
        if (b.type === "tool_call") toolCalls++;
      }
    }
  }
  return {
    title: session.title,
    source: session.source,
    messageCount: session.messages.length,
    roleCounts: counts,
    toolCalls,
    model: session.model,
  };
}

export function toJSON(session, { pretty = true } = {}) {
  return JSON.stringify(session, null, pretty ? 2 : 0);
}

export function fromJSON(data) {
  const session = typeof data === "string" ? JSON.parse(data) : data;
  if (!session || typeof session !== "object") {
    throw new Error("Invalid UCF data");
  }
  if (session.version !== UCF_VERSION) {
    return migrate(session);
  }
  return session;
}

function migrate(session) {
  return { ...emptySession(), ...session, version: UCF_VERSION };
}
