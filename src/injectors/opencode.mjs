import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { openSqlite } from "../lib/sqlite.mjs";
import { makeBlock, makeMessage } from "../ucf.mjs";
import { deriveTitle } from "../lib/title.mjs";
import { projectIdForDirectory } from "../lib/git-id.mjs";

function uid(prefix) {
  return prefix + "_" + randomUUID().replace(/-/g, "").slice(0, prefix === "ses" ? 20 : 24);
}

function ts() {
  return Date.now();
}

function ensureProject(db, cwd) {
  const { id: projectId, worktree } = projectIdForDirectory(cwd);
  const existing = db.prepare(`SELECT id FROM project WHERE id = ?`).get(projectId);
  if (existing) return projectId;
  const now = ts();
  const name = cwd ? path.basename(cwd) || cwd : "global";
  db.prepare(
    `INSERT INTO project (
      id, worktree, vcs, name, time_created, time_updated, sandboxes, commands
    ) VALUES (?, ?, NULL, ?, ?, ?, '[]', NULL)`,
  ).run(projectId, worktree, name, now, now);
  return projectId;
}

export async function writeOpenCode(session, dbPath) {
  const db = openSqlite(dbPath, { readonly: false });
  try {
    const cwd = session.cwd || process.cwd();
    const projectId = ensureProject(db, cwd);
    const sessionId = session.sessionId || uid("ses");
    const now = ts();
    const title = deriveTitle(session);
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "imported";

    db.prepare(
      `INSERT OR REPLACE INTO session (
        id, project_id, parent_id, slug, directory, title, version,
        time_created, time_updated, model, cost,
        tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write
      ) VALUES (
        @id, @project_id, @parent_id, @slug, @directory, @title, @version,
        @time_created, @time_updated, @model, @cost,
        0, 0, 0, 0, 0
      )`,
    ).run({
      id: sessionId,
      project_id: projectId,
      parent_id: null,
      slug,
      directory: cwd,
      title,
      version: "1.0.0",
      time_created: session.createdAt || now,
      time_updated: now,
      model: session.model || null,
      cost: 0,
    });

    const insertMessage = db.prepare(
      `INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)`,
    );
    const insertPart = db.prepare(
      `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)`,
    );

    db.transaction(() => {
      for (const m of session.messages) {
        const messageId = uid("msg");
        const mCreated = m.timestamp || now;
        const dataObj = {
          role: m.role,
          time: { created: mCreated },
        };
        if (m.modelId) dataObj.modelID = m.modelId;
        insertMessage.run(messageId, sessionId, mCreated, mCreated, JSON.stringify(dataObj));

        for (const b of m.blocks) {
          const partId = uid("prt");
          let partData = null;
          switch (b.type) {
            case "text":
              partData = { type: "text", text: b.text || "" };
              break;
            case "reasoning":
              partData = { type: "reasoning", text: b.text || "" };
              break;
            case "tool_call": {
              const status = b.output ? "completed" : b.status || "completed";
              partData = {
                type: "tool",
                tool: b.tool || "tool",
                callID: b.callId || uid("call"),
                state: {
                  status,
                  input: b.args || {},
                  raw: typeof b.args === "string" ? b.args : "",
                },
              };
              if (b.output) {
                partData.state.metadata = { output: typeof b.output === "string" ? b.output : JSON.stringify(b.output) };
              }
              break;
            }
            case "tool_result":
              partData = {
                type: "tool",
                tool: "tool_result",
                callID: b.toolCallId || "",
                state: {
                  status: "completed",
                  input: {},
                  raw: b.text || "",
                  metadata: { output: b.text || "" },
                },
              };
              break;
            case "file":
              partData = { type: "file", filename: b.path, mimeType: "text/plain", url: b.path, source: { text: { value: b.content || "" } } };
              break;
          }
          if (!partData) continue;
          insertPart.run(partId, messageId, sessionId, mCreated, mCreated, JSON.stringify(partData));
        }
      }
    })();

    return { sessionId, projectId, title };
  } finally {
    db.close();
  }
}
