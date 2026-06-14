import { openSqlite } from "../lib/sqlite.mjs";
import { emptySession, makeBlock, makeMessage } from "../ucf.mjs";
import { deriveTitle } from "../lib/title.mjs";

function tableHasColumn(db, table, column) {
  try {
    const row = db
      .prepare(`SELECT 1 AS hit FROM pragma_table_info(?) WHERE name = ?`)
      .get(table, column);
    return !!row;
  } catch {
    return false;
  }
}

function readModelFromThread(row, columns) {
  if (columns.hasModelSelectionJson && row.model_selection_json) {
    try {
      const sel = JSON.parse(row.model_selection_json);
      if (sel && typeof sel === "object") {
        if (sel.provider && sel.model) return `${sel.provider}/${sel.model}`;
        if (sel.model) return sel.model;
        if (sel.imported && sel.imported.model) return sel.imported.model;
      }
    } catch {}
  }
  if (columns.hasModel && row.model) {
    return row.model;
  }
  return null;
}

function describeColumns(db) {
  return {
    hasModel: tableHasColumn(db, "projection_threads", "model"),
    hasModelSelectionJson: tableHasColumn(db, "projection_threads", "model_selection_json"),
    hasInteractionMode: tableHasColumn(db, "projection_threads", "interaction_mode"),
    hasRuntimeMode: tableHasColumn(db, "projection_threads", "runtime_mode"),
    hasEnvMode: tableHasColumn(db, "projection_threads", "env_mode"),
    hasBranch: tableHasColumn(db, "projection_threads", "branch"),
    hasWorktreePath: tableHasColumn(db, "projection_threads", "worktree_path"),
    hasLatestUserMessageAt: tableHasColumn(db, "projection_threads", "latest_user_message_at"),
    hasParentThreadId: tableHasColumn(db, "projection_threads", "parent_thread_id"),
    hasSubagentNickname: tableHasColumn(db, "projection_threads", "subagent_nickname"),
    hasArchivedAt: tableHasColumn(db, "projection_threads", "archived_at"),
    hasPinned: tableHasColumn(db, "projection_threads", "is_pinned"),
    hasProjectKind: tableHasColumn(db, "projection_projects", "kind"),
    hasMessageSource: tableHasColumn(db, "projection_thread_messages", "source"),
    hasMessageSkills: tableHasColumn(db, "projection_thread_messages", "skills_json"),
    hasMessageMentions: tableHasColumn(db, "projection_thread_messages", "mentions_json"),
    hasMessageDispatchMode: tableHasColumn(db, "projection_thread_messages", "dispatch_mode"),
    hasMessageAttachments: tableHasColumn(db, "projection_thread_messages", "attachments_json"),
    hasActivitySequence: tableHasColumn(db, "projection_thread_activities", "sequence"),
  };
}

export function listThreads(dbPath) {
  const db = openSqlite(dbPath);
  try {
    const cols = describeColumns(db);
    const projectKindExpr = cols.hasProjectKind ? "p.kind" : "'project'";
    const branchExpr = cols.hasBranch ? "t.branch" : "NULL";
    const worktreeExpr = cols.hasWorktreePath ? "t.worktree_path" : "NULL";
    const runtimeExpr = cols.hasRuntimeMode ? "t.runtime_mode" : "'full-access'";
    const interactionExpr = cols.hasInteractionMode ? "t.interaction_mode" : "'default'";
    const latestUserExpr = cols.hasLatestUserMessageAt ? "t.latest_user_message_at" : "NULL";

    const sql = `
      SELECT t.thread_id, t.title, ${branchExpr} AS branch, ${worktreeExpr} AS worktree_path,
             t.created_at, t.updated_at, ${latestUserExpr} AS latest_user_message_at,
             t.model_selection_json, ${runtimeExpr} AS runtime_mode,
             ${interactionExpr} AS interaction_mode,
             p.title AS project_title, p.workspace_root, ${projectKindExpr} AS project_kind
      FROM projection_threads t
      LEFT JOIN projection_projects p ON t.project_id = p.project_id
      WHERE t.deleted_at IS NULL
      ORDER BY t.updated_at DESC
    `;
    const rows = db.prepare(sql).all();
    return rows.map((r) => {
      const model = readModelFromThread(r, cols);
      return {
        id: r.thread_id,
        title: r.title,
        branch: r.branch,
        cwd: r.workspace_root,
        projectTitle: r.project_title,
        projectKind: r.project_kind || null,
        model,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        latestUserMessageAt: r.latest_user_message_at,
        runtimeMode: r.runtime_mode,
        interactionMode: r.interaction_mode,
        source: "synara",
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
    const cols = describeColumns(db);
    const tRow = db
      .prepare(`SELECT * FROM projection_threads WHERE thread_id = ?`)
      .get(threadId);
    if (!tRow) throw new Error(`Thread not found: ${threadId}`);

    const projCols = ["title", "workspace_root"];
    if (cols.hasProjectKind) projCols.push("kind");
    const pRow = tRow.project_id
      ? db
          .prepare(`SELECT ${projCols.join(", ")} FROM projection_projects WHERE project_id = ?`)
          .get(tRow.project_id)
      : null;

    const model = readModelFromThread(tRow, cols);
    const session = emptySession({
      source: "synara",
      sessionId: tRow.thread_id,
      title: tRow.title,
      cwd: pRow?.workspace_root || null,
      model: model || tRow.model_selection_json || null,
      createdAt: tRow.created_at,
      updatedAt: tRow.updated_at,
    });
    session.metadata.synara = {
      branch: cols.hasBranch ? tRow.branch : null,
      worktreePath: cols.hasWorktreePath ? tRow.worktree_path : null,
      runtimeMode: cols.hasRuntimeMode ? tRow.runtime_mode : "full-access",
      interactionMode: cols.hasInteractionMode ? tRow.interaction_mode : "default",
      envMode: cols.hasEnvMode ? tRow.env_mode : "local",
      parentThreadId: cols.hasParentThreadId ? tRow.parent_thread_id : null,
      subagentNickname: cols.hasSubagentNickname ? tRow.subagent_nickname : null,
      archivedAt: cols.hasArchivedAt ? tRow.archived_at : null,
      pinned: cols.hasPinned ? !!tRow.is_pinned : false,
      projectKind: pRow?.kind || null,
      projectTitle: pRow?.title || null,
      legacyModelColumn: cols.hasModel ? tRow.model : null,
      modelSelectionJson: cols.hasModelSelectionJson ? tRow.model_selection_json : null,
    };

    const activities = db
      .prepare(
        `SELECT * FROM projection_thread_activities WHERE thread_id = ? ORDER BY created_at ASC, ${cols.hasActivitySequence ? "sequence" : "activity_id"} ASC`,
      )
      .all(threadId);

    const messages = db
      .prepare(
        `SELECT * FROM projection_thread_messages WHERE thread_id = ? ORDER BY created_at ASC`,
      )
      .all(threadId);

    for (const m of messages) {
      let attachments = null;
      if (cols.hasMessageAttachments && m.attachments_json) {
        try {
          attachments = JSON.parse(m.attachments_json);
        } catch {}
      }
      const blocks = [makeBlock("text", { text: m.text || "" })];
      if (attachments && Array.isArray(attachments) && attachments.length) {
        for (const a of attachments) {
          blocks.push(
            makeBlock("file", {
              path: a.path || a.name || "attachment",
              content: a.preview || a.content || "",
            }),
          );
        }
      }
      const meta = { turnId: m.turn_id, attachments };
      if (cols.hasMessageSource && m.source) meta.messageSource = m.source;
      if (cols.hasMessageDispatchMode && m.dispatch_mode) meta.dispatchMode = m.dispatch_mode;
      if (cols.hasMessageSkills && m.skills_json) {
        try { meta.skills = JSON.parse(m.skills_json); } catch {}
      }
      if (cols.hasMessageMentions && m.mentions_json) {
        try { meta.mentions = JSON.parse(m.mentions_json); } catch {}
      }
      session.messages.push(
        makeMessage({
          id: m.message_id,
          role: m.role,
          text: m.text || "",
          blocks,
          timestamp: m.created_at ? Date.parse(m.created_at) : null,
          metadata: meta,
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
      const blocks = [makeBlock("text", { text: `[${a.kind}] ${text}` })];
      if (payload && (payload.tool_name || payload.tool)) {
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
      session.messages.push(
        makeMessage({
          role: a.tone === "user" ? "user" : a.tone === "assistant" ? "assistant" : "system",
          text,
          blocks,
          timestamp: a.created_at ? Date.parse(a.created_at) : null,
          metadata: { kind: a.kind, tone: a.tone, activityId: a.activity_id, payload, sequence: a.sequence ?? null },
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
