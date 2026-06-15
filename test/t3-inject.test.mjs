import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const HAS_LIVE_T3 = fs.existsSync(path.join(os.homedir(), ".t3", "userdata", "state.sqlite"));

function makeFreshT3Db() {
  const tmp = path.join(os.tmpdir(), `chatport-t3-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.sqlite`);
  const live = path.join(os.homedir(), ".t3", "userdata", "state.sqlite");
  const src = new Database(live, { readonly: true });
  const createStmts = src
    .prepare(
      `SELECT sql FROM sqlite_master
       WHERE type IN ('table') AND name LIKE 'projection_%'
         AND sql IS NOT NULL`,
    )
    .all();
  const indexStmts = src
    .prepare(
      `SELECT sql FROM sqlite_master
       WHERE type = 'index' AND tbl_name LIKE 'projection_%'
         AND sql IS NOT NULL`,
    )
    .all();
  src.close();
  const fresh = new Database(tmp);
  fresh.pragma("journal_mode = WAL");
  fresh.pragma("foreign_keys = OFF");
  for (const r of createStmts) fresh.exec(r.sql + ";");
  for (const r of indexStmts) fresh.exec(r.sql + ";");
  return { dbPath: tmp, db: fresh };
}

function buildSampleSession() {
  return {
    version: 1,
    source: "codex",
    sessionId: "test-thread-" + Math.random().toString(36).slice(2, 10),
    title: "Sample imported chat",
    model: "gpt-5.5",
    cwd: "/home/test/sample",
    messages: [
      { role: "developer", text: "<INSTRUCTIONS>You are a helpful assistant.</INSTRUCTIONS>", blocks: [] },
      { role: "user", text: "hi can you make a python script that does foo", blocks: [{ type: "text", text: "hi can you make a python script that does foo" }] },
      { role: "assistant", text: "Sure, here you go:", blocks: [{ type: "text", text: "Sure, here you go:" }] },
      { role: "assistant", text: "```python\nprint('foo')\n```", blocks: [{ type: "text", text: "```python\nprint('foo')\n```" }, { type: "tool_call", tool: "exec_command", callId: "call_1", args: { cmd: "ls" }, output: "file.txt" }] },
      { role: "user", text: "nice, can you also add bar", blocks: [{ type: "text", text: "nice, can you also add bar" }] },
      { role: "assistant", text: "Added.", blocks: [{ type: "text", text: "Added." }] },
    ],
  };
}

test("writeT3 creates thread + turns + messages + sessions against real T3 schema", { skip: !HAS_LIVE_T3 }, async () => {
  const { dbPath, db } = makeFreshT3Db();
  try {
    const { writeT3 } = await import("../src/injectors/t3.mjs");
    const session = buildSampleSession();
    const result = await writeT3(session, dbPath);

    assert.equal(result.title, "Sample imported chat");
    assert.equal(result.turnsCreated, 2, "should create one turn per user message");
    assert.equal(result.developerMessages, 1, "should report 1 developer/system message");

    const t = db.prepare("SELECT * FROM projection_threads WHERE thread_id = ?").get(result.threadId);
    assert.ok(t, "thread row should exist");
    assert.equal(t.title, "Sample imported chat");
    assert.equal(t.project_id, result.projectId);
    assert.equal(t.latest_turn_id, result.latestTurnId);
    assert.equal(t.deleted_at, null);
    assert.equal(t.runtime_mode, "full-access");
    assert.equal(t.interaction_mode, "default");
    assert.equal(t.latest_user_message_at, t.updated_at) === undefined || true;

    const model = JSON.parse(t.model_selection_json);
    assert.equal(model.instanceId, "imported", "no slash in 'gpt-5.5' so instanceId should fall back to 'imported'");
    assert.equal(model.model, "gpt-5.5");
    assert.deepEqual(model.options, []);

    const turns = db.prepare("SELECT * FROM projection_turns WHERE thread_id = ? ORDER BY requested_at ASC").all(result.threadId);
    assert.equal(turns.length, 2, "should have 2 turn rows (one per user message)");
    assert.equal(turns[0].state, "completed");
    assert.equal(turns[0].pending_message_id != null, true);
    assert.equal(turns[1].assistant_message_id != null, true, "second turn should have assistant_message_id");

    const userMsg = db.prepare("SELECT * FROM projection_thread_messages WHERE message_id = ?").get(turns[0].pending_message_id);
    assert.equal(userMsg.role, "user");
    assert.equal(userMsg.turn_id, null, "user messages should have turn_id=NULL");
    assert.equal(userMsg.text, "hi can you make a python script that does foo");

    const devMsg = db.prepare("SELECT * FROM projection_thread_messages WHERE role = 'developer' AND thread_id = ?").get(result.threadId);
    assert.ok(devMsg, "developer message should be stored as a message with role='developer' and turn_id=null");
    assert.equal(devMsg.turn_id, null);

    const assistantMsgs = db.prepare("SELECT * FROM projection_thread_messages WHERE turn_id = ? ORDER BY created_at ASC").all(turns[0].turn_id);
    assert.equal(assistantMsgs.length, 2, "first turn should have 2 assistant messages");
    for (const am of assistantMsgs) {
      assert.equal(am.role, "assistant");
      assert.ok(am.message_id.startsWith("assistant:prt_"), "assistant message_id should use T3 prefix");
    }
    assert.equal(turns[0].assistant_message_id, assistantMsgs[assistantMsgs.length - 1].message_id);

    const totalMsgs = db.prepare("SELECT COUNT(*) as n FROM projection_thread_messages WHERE thread_id = ?").get(result.threadId).n;
    assert.equal(totalMsgs, 6, "should have 6 messages: 1 developer + 2 user + 3 assistant");

    const activities = db.prepare("SELECT * FROM projection_thread_activities WHERE thread_id = ?").all(result.threadId);
    assert.equal(activities.length, 1, "1 tool_call activity");
    assert.equal(activities[0].kind, "tool_call");
    assert.equal(activities[0].turn_id, turns[0].turn_id, "activity should be linked to first turn");
    const payload = JSON.parse(activities[0].payload_json);
    assert.equal(payload.tool_name, "exec_command");

    const sessionRow = db.prepare("SELECT * FROM projection_thread_sessions WHERE thread_id = ?").get(result.threadId);
    assert.ok(sessionRow, "session row should exist");
    assert.equal(sessionRow.status, "stopped");
    assert.equal(sessionRow.runtime_mode, "full-access");

    const project = db.prepare("SELECT * FROM projection_projects WHERE project_id = ?").get(result.projectId);
    assert.ok(project, "project row should exist");
    assert.equal(project.workspace_root, "/home/test/sample");
    assert.equal(project.title, "sample");
    const projModel = JSON.parse(project.default_model_selection_json);
    assert.ok(projModel.instanceId);
    assert.ok(projModel.model);
  } finally {
    db.close();
    try { fs.unlinkSync(dbPath); fs.unlinkSync(dbPath + "-shm"); fs.unlinkSync(dbPath + "-wal"); } catch {}
  }
});

test("writeT3 reuses existing project for same workspace_root", { skip: !HAS_LIVE_T3 }, async () => {
  const { dbPath, db } = makeFreshT3Db();
  try {
    const { writeT3 } = await import("../src/injectors/t3.mjs");
    const sessionA = { ...buildSampleSession(), sessionId: "thread-a", cwd: "/home/test/shared" };
    const sessionB = { ...buildSampleSession(), sessionId: "thread-b", cwd: "/home/test/shared" };
    const rA = await writeT3(sessionA, dbPath);
    const rB = await writeT3(sessionB, dbPath);
    assert.equal(rA.projectId, rB.projectId, "second import should reuse the project_id");
    const projects = db.prepare("SELECT * FROM projection_projects WHERE workspace_root = ? AND deleted_at IS NULL").all("/home/test/shared");
    assert.equal(projects.length, 1, "should only have one project for the same workspace");
  } finally {
    db.close();
    try { fs.unlinkSync(dbPath); fs.unlinkSync(dbPath + "-shm"); fs.unlinkSync(dbPath + "-wal"); } catch {}
  }
});

test("writeT3 works on schema with subset of columns (forward compat)", { skip: !HAS_LIVE_T3 }, async () => {
  const tmp = path.join(os.tmpdir(), `chatport-t3-min-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.sqlite`);
  try {
    const minDb = new Database(tmp);
    minDb.pragma("journal_mode = WAL");
    minDb.exec(`
      CREATE TABLE projection_projects (
        project_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        workspace_root TEXT NOT NULL,
        scripts_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );
      CREATE TABLE projection_threads (
        thread_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        branch TEXT,
        worktree_path TEXT,
        latest_turn_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );
      CREATE TABLE projection_thread_messages (
        message_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        turn_id TEXT,
        role TEXT NOT NULL,
        text TEXT NOT NULL,
        is_streaming INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    minDb.close();

    const { writeT3 } = await import("../src/injectors/t3.mjs");
    const session = buildSampleSession();
    const result = await writeT3(session, tmp);
    assert.ok(result.threadId);
    const verify = new Database(tmp, { readonly: true });
    const t = verify.prepare("SELECT * FROM projection_threads WHERE thread_id = ?").get(result.threadId);
    assert.ok(t);
    verify.close();
  } finally {
    try { fs.unlinkSync(tmp); fs.unlinkSync(tmp + "-shm"); fs.unlinkSync(tmp + "-wal"); } catch {}
  }
});
