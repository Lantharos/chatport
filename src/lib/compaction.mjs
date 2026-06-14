export const MODES = {
  NONE: "none",
  CODEX: "codex",
  GROK: "grok",
  OPENCODE: "opencode",
  T3: "t3",
};

export function detectCompaction(session) {
  if (!session) return session;
  if (!session.compaction || session.compaction.mode !== "none") return session;
  if (!Array.isArray(session.messages)) return session;

  if (session.source === "codex") return detectCodex(session);
  if (session.source === "grok") return detectGrok(session);
  if (session.source === "opencode") return detectOpenCode(session);
  if (session.source === "t3") return detectT3(session);
  return session;
}

function detectCodex(session) {
  const compactions = [];
  for (let i = 0; i < session.messages.length; i++) {
    const m = session.messages[i];
    if (m.metadata?.kind === "compaction" && Array.isArray(m.metadata?.replacementHistory)) {
      compactions.push({ index: i, replacement: m.metadata.replacementHistory, message: m.text });
    }
  }
  if (compactions.length === 0) return session;
  const last = compactions[compactions.length - 1];
  session.compaction = {
    mode: MODES.CODEX,
    count: compactions.length,
    cutIndex: last.index + 1,
    replacement: last.replacement,
    message: last.message,
    detectedAt: new Date().toISOString(),
  };
  return session;
}

function detectGrok(session) {
  const meta = session.metadata?.grok || {};
  const nextTraceTurn = typeof meta.nextTraceTurn === "number" ? meta.nextTraceTurn : null;
  const summaryText = typeof meta.sessionSummary === "string" ? meta.sessionSummary : null;
  const generatedTitle = typeof meta.generatedTitle === "string" ? meta.generatedTitle : null;
  if (nextTraceTurn == null && !summaryText) return session;

  const userIndices = [];
  for (let i = 0; i < session.messages.length; i++) {
    if (session.messages[i].role === "user") userIndices.push(i);
  }
  const userTurns = userIndices.length;
  let summaryTurns = nextTraceTurn ?? Math.max(0, userTurns - 5);
  if (summaryTurns > userTurns) summaryTurns = Math.max(0, userTurns - 1);
  const skipFirst = summaryTurns;
  const cutIndex = skipFirst > 0 && skipFirst <= userIndices.length ? userIndices[skipFirst] : 0;
  session.compaction = {
    mode: MODES.GROK,
    summaryTurns,
    summaryText: summaryText || null,
    generatedTitle: generatedTitle || null,
    gitRoot: meta.gitRootDir || null,
    headBranch: meta.headBranch || null,
    cutIndex,
    detectedAt: new Date().toISOString(),
  };
  return session;
}

function detectOpenCode(session) {
  const meta = session.metadata?.opencode || {};
  const hasSummary = (meta.tokens?.input || 0) > 0 && (meta.cost || 0) >= 0;
  if (!meta.compactedAt) return session;
  session.compaction = {
    mode: MODES.OPENCODE,
    cutIndex: session.messages.length,
    summaryAdditions: meta.summaryAdditions,
    summaryDeletions: meta.summaryDeletions,
    summaryFiles: meta.summaryFiles,
    detectedAt: new Date().toISOString(),
  };
  return session;
}

function detectT3(session) {
  const meta = session.metadata?.t3 || {};
  if (!meta.compacted) return session;
  session.compaction = {
    mode: MODES.T3,
    cutIndex: session.messages.length,
    detectedAt: new Date().toISOString(),
  };
  return session;
}

export function applyCompaction(session, { keep = "compacted" } = {}) {
  if (keep === "full" || !session.compaction || session.compaction.mode === MODES.NONE) {
    return session;
  }

  const cut = session.compaction.cutIndex ?? 0;
  const kept = session.messages.slice(cut);
  const summaryMessages = buildSummaryMessages(session);

  if (keep === "summary-only") {
    session.messages = summaryMessages;
    session.compaction.applied = "summary-only";
    return session;
  }

  if (keep === "compacted") {
    session.messages = [...summaryMessages, ...kept];
    session.compaction.applied = "compacted";
    session.compaction.keptCount = kept.length;
    session.compaction.summaryCount = summaryMessages.length;
    return session;
  }

  if (typeof keep === "number") {
    session.messages = kept.slice(-keep);
    session.compaction.applied = `last-${keep}`;
    return session;
  }

  return session;
}

function buildSummaryMessages(session) {
  const c = session.compaction || {};
  if (c.mode === MODES.CODEX && Array.isArray(c.replacement)) {
    return c.replacement.map((item) => normaliseCodexReplacement(item)).filter(Boolean);
  }
  if (c.mode === MODES.GROK) {
    const lines = [];
    if (c.summaryText) lines.push(`Earlier turns were summarized: ${c.summaryText}.`);
    else if (c.summaryTurns) lines.push(`The first ${c.summaryTurns} user turn(s) were summarized.`);
    else lines.push("Earlier turns were summarized by Grok.");
    if (c.generatedTitle) lines.push(`Topic: ${c.generatedTitle}.`);
    if (c.gitRoot) lines.push(`Project: ${c.gitRoot}.`);
    if (c.headBranch && c.headBranch !== "main" && c.headBranch !== "master") {
      lines.push(`Branch: ${c.headBranch}.`);
    }
    const text = `<compaction-summary>\n${lines.join("\n")}\n</compaction-summary>`;
    return [
      {
        role: "system",
        text,
        blocks: [{ type: "text", text }],
        timestamp: null,
        metadata: { compaction: true, source: "grok" },
      },
    ];
  }
  if (c.mode === MODES.OPENCODE || c.mode === MODES.T3) {
    const stats = [];
    if (c.summaryAdditions != null) stats.push(`+${c.summaryAdditions} lines`);
    if (c.summaryDeletions != null) stats.push(`-${c.summaryDeletions} lines`);
    if (c.summaryFiles != null) stats.push(`${c.summaryFiles} files`);
    const text = stats.length
      ? `<compaction-summary>\nEarlier turns were summarized (${stats.join(", ")}).\n</compaction-summary>`
      : `<compaction-summary>\nEarlier turns were summarized by the source client.\n</compaction-summary>`;
    return [
      {
        role: "system",
        text,
        blocks: [{ type: "text", text }],
        timestamp: null,
        metadata: { compaction: true, source: c.mode },
      },
    ];
  }
  return [];
}

function normaliseCodexReplacement(item) {
  if (!item || typeof item !== "object") return null;
  if (item.type === "message") {
    const role = item.role === "assistant" ? "assistant" : item.role === "user" ? "user" : "system";
    const blocks = (item.content || []).map((c) => {
      if (c.type === "input_text" || c.type === "output_text" || c.type === "text") {
        return { type: "text", text: c.text || "" };
      }
      return { type: "text", text: JSON.stringify(c) };
    });
    const text = blocks.map((b) => b.text).join("\n");
    return {
      role,
      text,
      blocks: blocks.length ? blocks : [{ type: "text", text: "" }],
      timestamp: null,
      metadata: { fromCompaction: true },
    };
  }
  if (item.type === "function_call") {
    return {
      role: "assistant",
      text: `[tool_call] ${item.name}`,
      blocks: [
        {
          type: "tool_call",
          tool: item.name,
          callId: item.call_id,
          args: typeof item.arguments === "string" ? safeParseJson(item.arguments) : item.arguments || {},
          status: "completed",
        },
      ],
      timestamp: null,
      metadata: { fromCompaction: true },
    };
  }
  if (item.type === "function_call_output") {
    return {
      role: "tool",
      text: typeof item.output === "string" ? item.output : item.output ? JSON.stringify(item.output) : "",
      blocks: [
        {
          type: "tool_result",
          toolCallId: item.call_id,
          text: typeof item.output === "string" ? item.output : item.output ? JSON.stringify(item.output) : "",
        },
      ],
      timestamp: null,
      metadata: { fromCompaction: true },
    };
  }
  return null;
}

function safeParseJson(s) {
  try { return JSON.parse(s); } catch { return { raw: s }; }
}

export function truncateToTurns(session, fromTurn, lastTurns) {
  if (!Array.isArray(session.messages)) return session;
  const userIndices = [];
  for (let i = 0; i < session.messages.length; i++) {
    if (session.messages[i].role === "user") userIndices.push(i);
  }
  let start = 0;
  if (typeof fromTurn === "number" && fromTurn > 0) {
    if (fromTurn < userIndices.length) start = userIndices[fromTurn];
  }
  if (typeof lastTurns === "number" && lastTurns > 0) {
    if (lastTurns < userIndices.length) {
      start = userIndices[userIndices.length - lastTurns];
    } else {
      start = 0;
    }
  }
  session.messages = session.messages.slice(start);
  return session;
}
