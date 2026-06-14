import { openSqlite } from "../lib/sqlite.mjs";
import { emptySession, makeBlock, makeMessage } from "../ucf.mjs";
import { deriveTitle } from "../lib/title.mjs";

export function listThreads(dbPath) {
  const db = openSqlite(dbPath);
  try {
    const rows = db
      .prepare(
        `SELECT t.thread_id, t.title, t.branch, t.worktree_path, t.created_at, t.updated_at,
                t.latest_user_message_at, t.model_selection_json, t.runtime_mode, t.interaction_mode,
                p.title AS project_title, p.workspace_root
         FROM projection_threads t
         LEFT JOIN projection_projects p ON t.project_id = p.project_id
         WHERE t.deleted_at IS NULL
         ORDER BY t.updated_at DESC`,
      )
      .all();
    return rows.map((r) => {
      let model = null;
      try {
        const m = JSON.parse(r.model_selection_json || "null");
        if (m && typeof m === "object") {
          if (m.provider && m.model) model = `${m.provider}/${m.model}`;
          else if (m.model) model = m.model;
          else if (m.imported && m.imported.model) model = m.imported.model;
          else {
            for (const [provider, sel] of Object.entries(m)) {
              if (sel && typeof sel === "object" && sel.model) {
                model = `${provider}/${sel.model}`;
                break;
              }
            }
          }
        }
      } catch {}
      return {
        id: r.thread_id,
        title: r.title,
        branch: r.branch,
        cwd: r.workspace_root,
        projectTitle: r.project_title,
        model,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        latestUserMessageAt: r.latest_user_message_at,
        runtimeMode: r.runtime_mode,
        interactionMode: r.interaction_mode,
        source: "t3",
        path: dbPath,
      };
    });
  } finally {
    db.close();
  }
}

export function readThread(dbPath, threadId) {
  const db = openSqlite(dbPath);
  try {
    const tRow = db
      .prepare(`SELECT * FROM projection_threads WHERE thread_id = ?`)
      .get(threadId);
    if (!tRow) throw new Error(`Thread not found: ${threadId}`);

    const pRow = tRow.project_id
      ? db
          .prepare(`SELECT title, workspace_root FROM projection_projects WHERE project_id = ?`)
          .get(tRow.project_id)
      : null;

    const session = emptySession({
      source: "t3",
      sessionId: tRow.thread_id,
      title: tRow.title,
      cwd: pRow?.workspace_root || null,
      model: tRow.model_selection_json || null,
      createdAt: tRow.created_at,
      updatedAt: tRow.updated_at,
    });
    session.metadata.t3 = {
      branch: tRow.branch,
      worktreePath: tRow.worktree_path,
      runtimeMode: tRow.runtime_mode,
      interactionMode: tRow.interaction_mode,
      projectTitle: pRow?.title || null,
    };

    const activities = db
      .prepare(
        `SELECT * FROM projection_thread_activities WHERE thread_id = ? ORDER BY created_at ASC, sequence ASC`,
      )
      .all(threadId);

    const messages = db
      .prepare(
        `SELECT * FROM projection_thread_messages WHERE thread_id = ? ORDER BY created_at ASC`,
      )
      .all(threadId);

    const messagesById = new Map(messages.map((m) => [m.message_id, m]));

    for (const m of messages) {
      let attachments = null;
      try {
        attachments = m.attachments_json ? JSON.parse(m.attachments_json) : null;
      } catch {}
      const blocks = [makeBlock("text", { text: m.text || "" })];
      if (attachments && Array.isArray(attachments) && attachments.length) {
        for (const a of attachments) {
          blocks.push(makeBlock("file", { path: a.path || a.name || "attachment", content: a.preview || "" }));
        }
      }
      session.messages.push(
        makeMessage({
          id: m.message_id,
          role: m.role,
          text: m.text || "",
          blocks,
          timestamp: m.created_at ? Date.parse(m.created_at) : null,
          metadata: { turnId: m.turn_id, attachments },
        }),
      );
    }

    for (const a of activities) {
      if (a.kind === "user_message" || a.kind === "assistant_message") continue;
      let payload = null;
      try {
        payload = JSON.parse(a.payload_json || "null");
      } catch {}
      const text = a.summary || a.kind;
      const blocks = [
        makeBlock("text", { text: `[${a.kind}] ${text}` }),
      ];
      if (payload) {
        if (payload.tool_name || payload.tool) {
          blocks.push(
            makeBlock("tool_call", {
              tool: payload.tool_name || payload.tool,
              callId: payload.call_id || payload.id,
              args: payload.input || payload.arguments || {},
              output: payload.output || "",
              status: payload.status || "completed",
            }),
          );
        }
      }
      session.messages.push(
        makeMessage({
          role: a.tone === "user" ? "user" : a.tone === "assistant" ? "assistant" : "system",
          text,
          blocks,
          timestamp: a.created_at ? Date.parse(a.created_at) : null,
          metadata: { kind: a.kind, tone: a.tone, activityId: a.activity_id, payload },
        }),
      );
    }

    session.messages.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    if (!session.title) session.title = deriveTitle(session);
    return session;
  } finally {
    db.close();
  }
}
