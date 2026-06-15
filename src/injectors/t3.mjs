import { openSqlite } from "../lib/sqlite.mjs";
import { randomUUID, randomBytes } from "node:crypto";
import path from "node:path";
import { deriveTitle } from "../lib/title.mjs";

function uid() {
  return randomUUID();
}

function ts() {
  return new Date().toISOString();
}

function assistantId() {
  return "assistant:prt_" + randomBytes(12).toString("base64").replace(/[+/=]/g, "");
}

function turnId() {
  return "chatport-turn-" + randomUUID();
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
    projectDefaultModelSelection: tableHasColumn(db, "projection_projects", "default_model_selection_json"),
    threadModelSelectionJson: tableHasColumn(db, "projection_threads", "model_selection_json"),
    threadInteractionMode: tableHasColumn(db, "projection_threads", "interaction_mode"),
    threadRuntimeMode: tableHasColumn(db, "projection_threads", "runtime_mode"),
    threadLatestUserMessageAt: tableHasColumn(db, "projection_threads", "latest_user_message_at"),
    threadPendingApprovalCount: tableHasColumn(db, "projection_threads", "pending_approval_count"),
    threadPendingUserInputCount: tableHasColumn(db, "projection_threads", "pending_user_input_count"),
    threadHasActionableProposedPlan: tableHasColumn(db, "projection_threads", "has_actionable_proposed_plan"),
    messageAttachments: tableHasColumn(db, "projection_thread_messages", "attachments_json"),
    activitySequence: tableHasColumn(db, "projection_thread_activities", "sequence"),
    turnsTable: tableHasColumn(db, "projection_turns", "thread_id"),
    sessionsTable: tableHasColumn(db, "projection_thread_sessions", "thread_id"),
  };
}

function buildModelSelection(session) {
  if (!session.model) return null;
  if (typeof session.model === "object" && session.model !== null) {
    if (session.model.instanceId && session.model.model) return session.model;
    if (session.model.provider && session.model.model) {
      return { instanceId: session.model.provider, model: session.model.model, options: [] };
    }
    if (session.model.model) {
      return { instanceId: "imported", model: session.model.model, options: [] };
    }
    return null;
  }
  const m = String(session.model);
  if (m.includes("/")) {
    const [provider, model] = m.split("/", 2);
    return { instanceId: provider, model, options: [] };
  }
  return { instanceId: "imported", model: m, options: [] };
}

function buildDefaultModelSelection(session) {
  const sel = buildModelSelection(session);
  return sel || { instanceId: "imported", model: "imported", options: [] };
}

function normalizeRole(role) {
  if (!role) return "user";
  const r = String(role).toLowerCase();
  if (r === "developer" || r === "system") return "developer";
  if (r === "assistant" || r === "model") return "assistant";
  if (r === "tool" || r === "tool_result" || r === "function") return "tool";
  return "user";
}

function buildMessageAttachments(m) {
  const fileBlocks = (m.blocks || []).filter((b) => b.type === "file");
  if (!fileBlocks.length) return null;
  return fileBlocks.map((b) => ({
    type: "file",
    name: b.path || b.name || "attachment",
    path: b.path || null,
    preview: b.content || b.preview || "",
  }));
}

function textForMessage(m) {
  if (m.text) return m.text;
  const tb = (m.blocks || []).find((b) => b.type === "text");
  return tb?.text || "";
}

function isUserMessage(m) {
  return normalizeRole(m.role) === "user";
}

function isAssistantMessage(m) {
  return normalizeRole(m.role) === "assistant";
}

function isDeveloperMessage(m) {
  return normalizeRole(m.role) === "developer";
}

function messageTimestamp(m, fallback) {
  if (m.timestamp) {
    const d = new Date(m.timestamp);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return fallback;
}

export async function writeT3(session, dbPath) {
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
    const defaultModelSelection = buildDefaultModelSelection(session);

    let pid = null;
    if (cols.turnsTable) {
      const existingProject = db
        .prepare(`SELECT project_id FROM projection_projects WHERE workspace_root = ? AND deleted_at IS NULL`)
        .get(workspaceRoot);
      if (existingProject?.project_id) {
        pid = existingProject.project_id;
        if (cols.projectDefaultModelSelection) {
          db.prepare(
            `UPDATE projection_projects SET updated_at = ?, default_model_selection_json = ? WHERE project_id = ?`,
          ).run(now, JSON.stringify(defaultModelSelection), pid);
        } else {
          db.prepare(`UPDATE projection_projects SET updated_at = ? WHERE project_id = ?`).run(now, pid);
        }
      }
    }
    if (!pid) {
      const projCols = ["project_id", "title", "workspace_root", "scripts_json", "created_at", "updated_at"];
      const projVals = [projectId, projectName, workspaceRoot, "[]", now, now];
      if (cols.projectDefaultModelSelection) {
        projCols.push("default_model_selection_json");
        projVals.push(JSON.stringify(defaultModelSelection));
      }
      const placeholders = projCols.map(() => "?").join(", ");
      db.prepare(
        `INSERT INTO projection_projects (${projCols.join(", ")}) VALUES (${placeholders})`,
      ).run(...projVals);
      pid = projectId;
    }

    const userMessages = session.messages.filter(isUserMessage);
    const lastUserMessage = userMessages[userMessages.length - 1];
    const latestUserMessageAt = lastUserMessage
      ? messageTimestamp(lastUserMessage, now)
      : null;

    let latestTurnId = null;
    const turnGroups = [];
    const developerMessages = [];
    let current = null;
    for (const m of session.messages) {
      if (isDeveloperMessage(m)) {
        developerMessages.push(m);
        continue;
      }
      if (isUserMessage(m)) {
        if (current) turnGroups.push(current);
        current = { user: m, assistants: [] };
      } else if (isAssistantMessage(m)) {
        if (!current) {
          current = { user: null, assistants: [m] };
        } else {
          current.assistants.push(m);
        }
      } else {
        if (!current) {
          current = { user: null, assistants: [] };
        }
        current.assistants.push(m);
      }
    }
    if (current) turnGroups.push(current);

    if (turnGroups.length === 0 && session.messages.length > 0) {
      turnGroups.push({ user: null, assistants: session.messages.filter((m) => !isDeveloperMessage(m)) });
    }

    const groupPlan = turnGroups.map((g) => {
      const userMsgId = g.user ? uid() : null;
      const assistantIds = g.assistants.map(() => assistantId());
      return {
        user: g.user,
        userMsgId,
        userTs: g.user ? messageTimestamp(g.user, now) : null,
        assistants: g.assistants,
        assistantIds,
        assistantTs: g.assistants.length
          ? messageTimestamp(g.assistants[g.assistants.length - 1], now)
          : null,
        turnId: turnId(),
      };
    });
    if (groupPlan.length) latestTurnId = groupPlan[groupPlan.length - 1].turnId;

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
      latestTurnId,
      now,
      now,
      null,
    ];
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
    if (cols.threadLatestUserMessageAt) {
      threadCols.push("latest_user_message_at");
      threadVals.push(latestUserMessageAt);
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
    const threadPlaceholders = threadCols.map(() => "?").join(", ");
    db.prepare(
      `INSERT OR REPLACE INTO projection_threads (${threadCols.join(", ")}) VALUES (${threadPlaceholders})`,
    ).run(...threadVals);

    const insertTurn = cols.turnsTable
      ? db.prepare(
          `INSERT OR REPLACE INTO projection_turns (
            thread_id, turn_id, pending_message_id, assistant_message_id,
            state, requested_at, started_at, completed_at, checkpoint_files_json
          ) VALUES (?, ?, ?, ?, 'completed', ?, ?, ?, '[]')`,
        )
      : null;

    const msgCols = ["message_id", "thread_id", "turn_id", "role", "text", "is_streaming", "created_at", "updated_at"];
    if (cols.messageAttachments) msgCols.push("attachments_json");
    const insertMessage = db.prepare(
      `INSERT OR REPLACE INTO projection_thread_messages (${msgCols.join(", ")}) VALUES (${msgCols.map(() => "?").join(", ")})`,
    );

    const actCols = ["activity_id", "thread_id", "turn_id", "tone", "kind", "summary", "payload_json", "created_at"];
    if (cols.activitySequence) actCols.push("sequence");
    const insertActivity = cols.turnsTable && tableHasColumn(db, "projection_thread_activities", "activity_id")
      ? db.prepare(
          `INSERT OR REPLACE INTO projection_thread_activities (${actCols.join(", ")}) VALUES (${actCols.map(() => "?").join(", ")})`,
        )
      : null;

    const insertSession = cols.sessionsTable
      ? db.prepare(
          `INSERT OR REPLACE INTO projection_thread_sessions (
            thread_id, status, provider_name, provider_session_id, provider_thread_id,
            active_turn_id, last_error, updated_at, runtime_mode, provider_instance_id
          ) VALUES (?, 'stopped', ?, NULL, NULL, NULL, NULL, ?, 'full-access', ?)`,
        )
      : null;

    db.transaction(() => {
      let activitySeq = 0;
      for (const g of groupPlan) {
        const turnIdValue = g.turnId;

        if (g.user && insertTurn) {
          const userAttachments = buildMessageAttachments(g.user);
          const userMsgVals = [
            g.userMsgId,
            threadId,
            null,
            "user",
            textForMessage(g.user),
            0,
            g.userTs,
            g.userTs,
          ];
          if (cols.messageAttachments) {
            userMsgVals.push(userAttachments ? JSON.stringify(userAttachments) : null);
          }
          insertMessage.run(...userMsgVals);

          const assistantIdForTurn = g.assistants.length
            ? g.assistantIds[g.assistantIds.length - 1]
            : null;
          insertTurn.run(
            threadId,
            turnIdValue,
            g.userMsgId,
            assistantIdForTurn,
            g.userTs,
            g.userTs,
            g.assistantTs || g.userTs,
          );
        }

        for (let i = 0; i < g.assistants.length; i++) {
          const m = g.assistants[i];
          const messageId = g.assistantIds[i];
          const tsValue = messageTimestamp(m, g.assistantTs || now);
          const attachments = buildMessageAttachments(m);
          const msgVals = [
            messageId,
            threadId,
            turnIdValue,
            "assistant",
            textForMessage(m),
            0,
            tsValue,
            tsValue,
          ];
          if (cols.messageAttachments) {
            msgVals.push(attachments ? JSON.stringify(attachments) : null);
          }
          insertMessage.run(...msgVals);

          if (insertActivity) {
            for (const b of m.blocks || []) {
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
                  turnIdValue,
                  "assistant",
                  "tool_call",
                  `Tool call: ${b.tool}`,
                  JSON.stringify(payload),
                  tsValue,
                ];
                if (cols.activitySequence) actVals.push(activitySeq++);
                insertActivity.run(...actVals);
              } else if (b.type === "tool_result") {
                const payload = {
                  tool_name: b.tool || "tool_result",
                  call_id: b.toolCallId || null,
                  input: {},
                  output: b.text || b.content || "",
                  status: "completed",
                };
                const actVals = [
                  uid(),
                  threadId,
                  turnIdValue,
                  "tool",
                  "tool_call",
                  `Tool result: ${b.tool || "tool"}`,
                  JSON.stringify(payload),
                  tsValue,
                ];
                if (cols.activitySequence) actVals.push(activitySeq++);
                insertActivity.run(...actVals);
              }
            }
          }
        }
      }

      if (insertSession) {
        const providerName = modelSelection?.instanceId || "imported";
        insertSession.run(threadId, providerName, now, providerName);
      }

      for (const dm of developerMessages) {
        const devTs = messageTimestamp(dm, now);
        const devAttachments = buildMessageAttachments(dm);
        const devVals = [
          uid(),
          threadId,
          null,
          "developer",
          textForMessage(dm),
          0,
          devTs,
          devTs,
        ];
        if (cols.messageAttachments) {
          devVals.push(devAttachments ? JSON.stringify(devAttachments) : null);
        }
        insertMessage.run(...devVals);
      }
    })();

    return {
      threadId,
      projectId: pid,
      title,
      latestTurnId,
      turnsCreated: groupPlan.length,
      developerMessages: developerMessages.length,
    };
  } finally {
    db.close();
  }
}
