import { openSqlite } from "../lib/sqlite.mjs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { deriveTitle } from "../lib/title.mjs";

function uid() {
  return randomUUID();
}

function ts() {
  return new Date().toISOString();
}

export async function writeT3(session, dbPath) {
  const db = openSqlite(dbPath, { readonly: false });
  try {
    const threadId = session.sessionId || uid();
    const now = ts();
    const projectId = uid();
    const workspaceRoot = session.cwd || process.cwd();
    const title = deriveTitle(session);
    const projectName = path.basename(workspaceRoot) || "imported";

    const existingProject = db
      .prepare(`SELECT project_id FROM projection_projects WHERE workspace_root = ? AND deleted_at IS NULL`)
      .get(workspaceRoot);

    let pid = existingProject?.project_id;
    if (!pid) {
      db.prepare(
        `INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(projectId, projectName, workspaceRoot, "[]", now, now);
      pid = projectId;
    } else {
      db.prepare(`UPDATE projection_projects SET updated_at = ? WHERE project_id = ?`).run(now, pid);
    }

    db.prepare(
      `INSERT OR REPLACE INTO projection_threads (
        thread_id, project_id, title, branch, worktree_path, latest_turn_id,
        created_at, updated_at, deleted_at, runtime_mode, interaction_mode,
        model_selection_json, archived_at, latest_user_message_at,
        pending_approval_count, pending_user_input_count, has_actionable_proposed_plan
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'full-access', 'default', ?, NULL, ?, 0, 0, 0)`,
    ).run(
      threadId,
      pid,
      title,
      null,
      null,
      null,
      now,
      now,
      session.model ? JSON.stringify({ imported: { model: session.model } }) : null,
      now,
    );

    const insertMessage = db.prepare(
      `INSERT OR REPLACE INTO projection_thread_messages (
        message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at, attachments_json
      ) VALUES (?, ?, NULL, ?, ?, 0, ?, ?, ?)`,
    );

    const insertActivity = db.prepare(
      `INSERT OR REPLACE INTO projection_thread_activities (
        activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at, sequence
      ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
    );

    db.transaction(() => {
      let i = 0;
      for (const m of session.messages) {
        const msgId = m.id || uid();
        const createdAt = m.timestamp ? new Date(m.timestamp).toISOString() : now;
        const text = m.text || (m.blocks.find((b) => b.type === "text")?.text ?? "");
        let attachments = null;
        const fileBlocks = m.blocks.filter((b) => b.type === "file");
        if (fileBlocks.length) {
          attachments = fileBlocks.map((b) => ({ path: b.path, preview: b.content }));
        }
        insertMessage.run(
          msgId,
          threadId,
          m.role,
          text,
          createdAt,
          createdAt,
          attachments ? JSON.stringify(attachments) : null,
        );

        for (const b of m.blocks) {
          if (b.type === "tool_call") {
            const payload = {
              tool_name: b.tool,
              call_id: b.callId,
              input: b.args || {},
              output: b.output || "",
              status: b.status || "completed",
            };
            insertActivity.run(
              uid(),
              threadId,
              m.role === "assistant" ? "assistant" : m.role === "user" ? "user" : "system",
              "tool_call",
              `Tool call: ${b.tool}`,
              JSON.stringify(payload),
              createdAt,
              i++,
            );
          }
        }
        i++;
      }
    })();

    return { threadId, projectId: pid, title };
  } finally {
    db.close();
  }
}
