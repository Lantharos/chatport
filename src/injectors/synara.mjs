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

function describeColumns(db) {
  return {
    projectKind: tableHasColumn(db, "projection_projects", "kind"),
    projectDefaultModelSelection: tableHasColumn(db, "projection_projects", "default_model_selection_json"),
    threadModel: tableHasColumn(db, "projection_threads", "model"),
    threadModelSelectionJson: tableHasColumn(db, "projection_threads", "model_selection_json"),
    threadInteractionMode: tableHasColumn(db, "projection_threads", "interaction_mode"),
    threadRuntimeMode: tableHasColumn(db, "projection_threads", "runtime_mode"),
    threadEnvMode: tableHasColumn(db, "projection_threads", "env_mode"),
    threadLatestUserMessageAt: tableHasColumn(db, "projection_threads", "latest_user_message_at"),
    threadPendingApprovalCount: tableHasColumn(db, "projection_threads", "pending_approval_count"),
    threadPendingUserInputCount: tableHasColumn(db, "projection_threads", "pending_user_input_count"),
    threadHasActionableProposedPlan: tableHasColumn(db, "projection_threads", "has_actionable_proposed_plan"),
    messageSource: tableHasColumn(db, "projection_thread_messages", "source"),
    messageSkills: tableHasColumn(db, "projection_thread_messages", "skills_json"),
    messageMentions: tableHasColumn(db, "projection_thread_messages", "mentions_json"),
    messageDispatchMode: tableHasColumn(db, "projection_thread_messages", "dispatch_mode"),
    messageAttachments: tableHasColumn(db, "projection_thread_messages", "attachments_json"),
    activitySequence: tableHasColumn(db, "projection_thread_activities", "sequence"),
  };
}

function buildModelSelection(session) {
  if (!session.model) return null;
  if (typeof session.model === "object") return session.model;
  const m = String(session.model);
  if (m.includes("/")) {
    const [provider, model] = m.split("/", 2);
    return { provider, model };
  }
  return { provider: "imported", model: m };
}

export async function writeSynara(session, dbPath) {
  const db = openSqlite(dbPath, { readonly: false });
  try {
    const cols = describeColumns(db);
    const threadId = session.sessionId || uid();
    const now = ts();
    const projectId = uid();
    const workspaceRoot = session.cwd || process.cwd();
    const title = deriveTitle(session);
    const projectName = path.basename(workspaceRoot) || "imported";
    const modelSelection = buildModelSelection(session);

    const existingProject = db
      .prepare(`SELECT project_id FROM projection_projects WHERE workspace_root = ? AND deleted_at IS NULL`)
      .get(workspaceRoot);

    let pid = existingProject?.project_id;
    if (!pid) {
      const projCols = ["project_id", "title", "workspace_root", "scripts_json", "created_at", "updated_at"];
      const projVals = [projectId, projectName, workspaceRoot, "[]", now, now];
      if (cols.projectKind) {
        projCols.push("kind");
        projVals.push("project");
      }
      if (cols.projectDefaultModelSelection) {
        projCols.push("default_model_selection_json");
        projVals.push(modelSelection ? JSON.stringify(modelSelection) : null);
      }
      const placeholders = projCols.map(() => "?").join(", ");
      db.prepare(
        `INSERT INTO projection_projects (${projCols.join(", ")}) VALUES (${placeholders})`,
      ).run(...projVals);
      pid = projectId;
    } else {
      const updateParts = ["updated_at = ?"];
      const updateVals = [now];
      if (cols.projectDefaultModelSelection && modelSelection) {
        updateParts.push("default_model_selection_json = ?");
        updateVals.push(JSON.stringify(modelSelection));
      }
      db.prepare(
        `UPDATE projection_projects SET ${updateParts.join(", ")} WHERE project_id = ?`,
      ).run(...updateVals, pid);
    }

    const threadCols = [
      "thread_id",
      "project_id",
      "title",
      "branch",
      "worktree_path",
      "latest_turn_id",
      "created_at",
      "updated_at",
      "deleted_at",
    ];
    const threadVals = [
      threadId,
      pid,
      title,
      null,
      null,
      null,
      now,
      now,
      null,
    ];
    if (cols.threadModel) {
      threadCols.push("model");
      threadVals.push(typeof session.model === "string" ? session.model : (modelSelection?.model ?? null));
    }
    if (cols.threadModelSelectionJson) {
      threadCols.push("model_selection_json");
      threadVals.push(modelSelection ? JSON.stringify(modelSelection) : null);
    }
    if (cols.threadRuntimeMode) {
      threadCols.push("runtime_mode");
      threadVals.push("full-access");
    }
    if (cols.threadInteractionMode) {
      threadCols.push("interaction_mode");
      threadVals.push("default");
    }
    if (cols.threadEnvMode) {
      threadCols.push("env_mode");
      threadVals.push("local");
    }
    if (cols.threadLatestUserMessageAt) {
      threadCols.push("latest_user_message_at");
      threadVals.push(now);
    }
    if (cols.threadPendingApprovalCount) {
      threadCols.push("pending_approval_count");
      threadVals.push(0);
    }
    if (cols.threadPendingUserInputCount) {
      threadCols.push("pending_user_input_count");
      threadVals.push(0);
    }
    if (cols.threadHasActionableProposedPlan) {
      threadCols.push("has_actionable_proposed_plan");
      threadVals.push(0);
    }
    const placeholders = threadCols.map(() => "?").join(", ");
    db.prepare(
      `INSERT OR REPLACE INTO projection_threads (${threadCols.join(", ")}) VALUES (${placeholders})`,
    ).run(...threadVals);

    const msgCols = ["message_id", "thread_id", "turn_id", "role", "text", "is_streaming", "created_at", "updated_at"];
    if (cols.messageAttachments) msgCols.push("attachments_json");
    if (cols.messageSource) msgCols.push("source");
    if (cols.messageSkills) msgCols.push("skills_json");
    if (cols.messageMentions) msgCols.push("mentions_json");
    if (cols.messageDispatchMode) msgCols.push("dispatch_mode");
    const insertMessage = db.prepare(
      `INSERT OR REPLACE INTO projection_thread_messages (${msgCols.join(", ")}) VALUES (${msgCols.map(() => "?").join(", ")})`,
    );

    const actCols = ["activity_id", "thread_id", "turn_id", "tone", "kind", "summary", "payload_json", "created_at"];
    if (cols.activitySequence) actCols.push("sequence");
    const insertActivity = db.prepare(
      `INSERT OR REPLACE INTO projection_thread_activities (${actCols.join(", ")}) VALUES (${actCols.map(() => "?").join(", ")})`,
    );

    db.transaction(() => {
      let seq = 0;
      for (const m of session.messages) {
        const msgId = m.id || uid();
        const createdAt = m.timestamp ? new Date(m.timestamp).toISOString() : now;
        const text = m.text || (m.blocks.find((b) => b.type === "text")?.text ?? "");
        let attachments = null;
        const fileBlocks = m.blocks.filter((b) => b.type === "file");
        if (fileBlocks.length) {
          attachments = fileBlocks.map((b) => ({ path: b.path, preview: b.content }));
        }
        const msgVals = [
          msgId,
          threadId,
          null,
          m.role,
          text,
          0,
          createdAt,
          createdAt,
        ];
        if (cols.messageAttachments) {
          msgVals.push(attachments ? JSON.stringify(attachments) : null);
        }
        if (cols.messageSource) {
          msgVals.push(m.metadata?.messageSource || "imported");
        }
        if (cols.messageSkills) {
          msgVals.push(m.metadata?.skills ? JSON.stringify(m.metadata.skills) : null);
        }
        if (cols.messageMentions) {
          msgVals.push(m.metadata?.mentions ? JSON.stringify(m.metadata.mentions) : null);
        }
        if (cols.messageDispatchMode) {
          msgVals.push(m.metadata?.dispatchMode || null);
        }
        insertMessage.run(...msgVals);

        for (const b of m.blocks) {
          if (b.type === "tool_call") {
            const payload = {
              tool_name: b.tool,
              call_id: b.callId,
              input: b.args || {},
              output: b.output || "",
              status: b.status || "completed",
            };
            const actVals = [
              uid(),
              threadId,
              null,
              m.role === "assistant" ? "assistant" : m.role === "user" ? "user" : "system",
              "tool_call",
              `Tool call: ${b.tool}`,
              JSON.stringify(payload),
              createdAt,
            ];
            if (cols.activitySequence) actVals.push(seq++);
            insertActivity.run(...actVals);
          }
        }
        seq++;
      }
    })();

    return { threadId, projectId: pid, title };
  } finally {
    db.close();
  }
}
