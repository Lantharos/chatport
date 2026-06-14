import { openSqlite } from "../lib/sqlite.mjs";
import { emptySession, makeBlock, makeMessage, textOf } from "../ucf.mjs";
import { deriveTitle } from "../lib/title.mjs";

export function listSessions(dbPath) {
  const db = openSqlite(dbPath);
  try {
    const rows = db
      .prepare(
        `SELECT id, title, directory, slug, time_created, time_updated, agent, model, cost, parent_id
         FROM session
         WHERE time_archived IS NULL
         ORDER BY time_created DESC`,
      )
      .all();
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      cwd: r.directory,
      slug: r.slug,
      model: r.model,
      agent: r.agent,
      cost: r.cost,
      parentId: r.parent_id,
      createdAt: r.time_created,
      updatedAt: r.time_updated,
      source: "opencode",
    }));
  } finally {
    db.close();
  }
}

function parsePart(p) {
  let data;
  try {
    data = JSON.parse(p.data);
  } catch {
    return null;
  }
  if (!data) return null;
  switch (data.type) {
    case "text":
      return makeBlock("text", { text: data.text || "" });
    case "reasoning":
      return makeBlock("reasoning", { text: data.text || "" });
    case "file":
      return makeBlock("file", { path: data.filename || data.path, content: data.source?.text?.value || data.text || "" });
    case "tool": {
      const state = data.state || {};
      const meta = state.metadata || {};
      return makeBlock("tool_call", {
        tool: data.tool,
        callId: data.callID,
        args: state.input || {},
        output: meta.output || "",
        status: state.status || "pending",
        description: meta.description || null,
      });
    }
    case "step-start":
    case "step-finish":
    case "snapshot":
    case "patch":
      return null;
    default:
      return makeBlock("text", { text: JSON.stringify(data) });
  }
}

export function readSession(dbPath, sessionId) {
  const db = openSqlite(dbPath);
  try {
    const sRow = db.prepare(`SELECT * FROM session WHERE id = ?`).get(sessionId);
    if (!sRow) throw new Error(`Session not found: ${sessionId}`);

    const session = emptySession({
      source: "opencode",
      sessionId: sRow.id,
      title: sRow.title,
      cwd: sRow.directory,
      model: sRow.model,
      createdAt: sRow.time_created,
      updatedAt: sRow.time_updated,
    });
    session.metadata.opencode = {
      slug: sRow.slug,
      agent: sRow.agent,
      version: sRow.version,
      cost: sRow.cost,
      tokens: {
        input: sRow.tokens_input,
        output: sRow.tokens_output,
        reasoning: sRow.tokens_reasoning,
        cacheRead: sRow.tokens_cache_read,
        cacheWrite: sRow.tokens_cache_write,
      },
      modelID: sRow.model,
      providerID: sRow.path,
      summaryAdditions: sRow.summary_additions,
      summaryDeletions: sRow.summary_deletions,
      summaryFiles: sRow.summary_files,
      compactedAt: sRow.time_compacting || null,
    };

    const messages = db
      .prepare(
        `SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created ASC`,
      )
      .all(sessionId);

    for (const m of messages) {
      let mdata;
      try {
        mdata = JSON.parse(m.data);
      } catch {
        continue;
      }
      const parts = db
        .prepare(
          `SELECT id, data FROM part WHERE message_id = ? ORDER BY time_created ASC`,
        )
        .all(m.id);

      const blocks = parts
        .map((p) => parsePart(p))
        .filter(Boolean);

      if (blocks.length === 0) continue;

      const ts = mdata?.time?.created || m.time_created;
      const text = textOf(blocks);

      session.messages.push(
        makeMessage({
          id: m.id,
          role: mdata.role || "assistant",
          text,
          blocks,
          timestamp: ts,
          modelId: mdata.modelID || null,
          metadata: {
            agent: mdata.agent || null,
            mode: mdata.mode || null,
            finish: mdata.finish || null,
            path: mdata.path || null,
            parentID: mdata.parentID || null,
          },
        }),
      );
    }
    if (
      !session.title ||
      session.title.startsWith("T3 Code ") ||
      session.title === "generateThreadTitle" ||
      session.title === "generateCommitMessage"
    ) {
      session.title = deriveTitle(session);
    }
    return session;
  } finally {
    db.close();
  }
}
