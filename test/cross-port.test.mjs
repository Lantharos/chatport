import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HAS_DATA = {
  codex: fs.existsSync(path.join(os.homedir(), ".codex", "sessions")),
  grok: fs.existsSync(path.join(os.homedir(), ".grok", "sessions")),
  t3: fs.existsSync(path.join(os.homedir(), ".t3", "userdata", "state.sqlite")),
};

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`));
}

function rmTmp(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

async function pickCodex() {
  const { listSessions } = await import("../src/parsers/codex.mjs");
  const all = await listSessions(path.join(os.homedir(), ".codex", "sessions"));
  return all[0];
}

async function pickGrok() {
  const { listSessions } = await import("../src/parsers/grok.mjs");
  const all = await listSessions(path.join(os.homedir(), ".grok", "sessions"));
  return all.find((s) => (s.numChatMessages || 0) > 1) || all[0];
}

test("codex -> codex round-trip preserves messages", { skip: !HAS_DATA.codex }, async () => {
  const { listSessions, readSession } = await import("../src/parsers/codex.mjs");
  const { writeCodex } = await import("../src/injectors/codex.mjs");
  const src = await pickCodex();
  const outDir = tmpDir("chatport-codex-out");
  try {
    const target = await writeCodex(await readSession(src.path), outDir);
    assert.ok(target.endsWith(".jsonl"));
    const listed = await listSessions(outDir);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, src.id);
    const srcSession = await readSession(src.path);
    const round = await readSession(listed[0].path);
    assert.ok(round.messages.length > 0);
    const srcRoleCount = {};
    for (const m of srcSession.messages) srcRoleCount[m.role] = (srcRoleCount[m.role] || 0) + 1;
    const dstRoleCount = {};
    for (const m of round.messages) dstRoleCount[m.role] = (dstRoleCount[m.role] || 0) + 1;
    assert.equal(dstRoleCount.user || 0, srcRoleCount.user || 0, "user count should round-trip");
    assert.equal(dstRoleCount.tool || 0, srcRoleCount.tool || 0, "tool count should round-trip");
    const srcToolCalls = srcSession.messages.reduce((n, m) => n + (m.blocks || []).filter((b) => b.type === "tool_call").length, 0);
    const dstToolCalls = round.messages.reduce((n, m) => n + (m.blocks || []).filter((b) => b.type === "tool_call").length, 0);
    assert.equal(dstToolCalls, srcToolCalls, "tool_call count should round-trip");
    assert.equal(dstRoleCount.assistant || 0, srcRoleCount.assistant || 0, "assistant count should round-trip");
  } finally { rmTmp(outDir); }
});

test("grok -> grok round-trip preserves messages", { skip: !HAS_DATA.grok }, async () => {
  const { listSessions, readSession } = await import("../src/parsers/grok.mjs");
  const { writeGrok } = await import("../src/injectors/grok.mjs");
  const src = await pickGrok();
  const outDir = tmpDir("chatport-grok-out");
  try {
    const target = await writeGrok(await readSession(src.path), outDir);
    assert.ok(fs.existsSync(path.join(target, "chat_history.jsonl")));
    assert.ok(fs.existsSync(path.join(target, "summary.json")));
    const listed = await listSessions(outDir);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, src.id);
    const round = await readSession(listed[0].path);
    assert.ok(round.messages.length > 0);
    const srcSession = await readSession(src.path);
    const srcUser = srcSession.messages.filter((m) => m.role === "user").length;
    const dstUser = round.messages.filter((m) => m.role === "user").length;
    assert.equal(dstUser, srcUser, "user count should round-trip");
  } finally { rmTmp(outDir); }
});

test("codex -> grok round-trip (cross-port)", { skip: !HAS_DATA.codex }, async () => {
  const { listSessions, readSession } = await import("../src/parsers/codex.mjs");
  const { listSessions: grokList, readSession: grokRead } = await import("../src/parsers/grok.mjs");
  const { writeGrok } = await import("../src/injectors/grok.mjs");
  const src = await pickCodex();
  const outDir = tmpDir("chatport-c2g-out");
  try {
    await writeGrok(await readSession(src.path), outDir);
    const listed = await grokList(outDir);
    assert.equal(listed.length, 1);
    const round = await grokRead(listed[0].path);
    assert.ok(round.messages.length > 0);
    const toolResults = round.messages.filter((m) => m.role === "tool").length;
    const toolCalls = round.messages
      .filter((m) => m.role === "assistant")
      .reduce((n, m) => n + (m.blocks || []).filter((b) => b.type === "tool_call").length, 0);
    assert.ok(toolCalls > 0, "should have at least one tool call");
    assert.equal(toolResults, toolCalls, "every tool_call in a codex source should produce a tool_result in grok (even when output is embedded in the tool_call block)");
  } finally { rmTmp(outDir); }
});

test("grok -> codex round-trip (cross-port)", { skip: !HAS_DATA.grok }, async () => {
  const { listSessions, readSession } = await import("../src/parsers/grok.mjs");
  const { listSessions: codexList, readSession: codexRead } = await import("../src/parsers/codex.mjs");
  const { writeCodex } = await import("../src/injectors/codex.mjs");
  const src = await pickGrok();
  const outDir = tmpDir("chatport-g2c-out");
  try {
    await writeCodex(await readSession(src.path), outDir);
    const listed = await codexList(outDir);
    assert.equal(listed.length, 1);
    const round = await codexRead(listed[0].path);
    assert.ok(round.messages.length > 0);
    const callIds = new Set();
    const outputIds = new Set();
    for (const m of round.messages) {
      for (const b of m.blocks || []) {
        if (b.type === "tool_call" && b.callId) callIds.add(b.callId);
        if (b.type === "tool_result" && b.toolCallId) outputIds.add(b.toolCallId);
      }
    }
    for (const cid of callIds) {
      assert.ok(outputIds.has(cid), `every function_call (${cid}) should have a matching function_call_output`);
    }
  } finally { rmTmp(outDir); }
});

test("codex -> T3 round-trip with full schema", { skip: !HAS_DATA.codex || !HAS_DATA.t3 }, async () => {
  const { listSessions, readSession } = await import("../src/parsers/codex.mjs");
  const { writeT3 } = await import("../src/injectors/t3.mjs");
  const Database = (await import("better-sqlite3")).default;
  const live = path.join(os.homedir(), ".t3", "userdata", "state.sqlite");
  const src = new Database(live, { readonly: true });
  const createStmts = src.prepare("SELECT sql FROM sqlite_master WHERE type IN ('table') AND name LIKE 'projection_%' AND sql IS NOT NULL").all();
  const indexStmts = src.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name LIKE 'projection_%' AND sql IS NOT NULL").all();
  src.close();
  const tmp = path.join(os.tmpdir(), `chatport-t3-rt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.sqlite`);
  const fresh = new Database(tmp);
  fresh.pragma("journal_mode = WAL");
  for (const r of createStmts) fresh.exec(r.sql + ";");
  for (const r of indexStmts) fresh.exec(r.sql + ";");
  fresh.close();
  try {
    const codex = await pickCodex();
    const session = await readSession(codex.path);
    const r = await writeT3(session, tmp);
    assert.ok(r.turnsCreated > 0, "should create at least one turn");
    const db = new Database(tmp, { readonly: true });
    const turns = db.prepare("SELECT COUNT(*) as n FROM projection_turns WHERE thread_id = ?").get(r.threadId).n;
    const userMsgs = db.prepare("SELECT COUNT(*) as n FROM projection_thread_messages WHERE thread_id = ? AND role = 'user'").get(r.threadId).n;
    const asstMsgs = db.prepare("SELECT COUNT(*) as n FROM projection_thread_messages WHERE thread_id = ? AND role = 'assistant'").get(r.threadId).n;
    db.close();
    assert.equal(turns, userMsgs, "turn count should equal user message count");
    assert.ok(asstMsgs >= userMsgs, "should have at least as many assistant messages as user messages");
  } finally {
    try { fs.unlinkSync(tmp); fs.unlinkSync(tmp + "-shm"); fs.unlinkSync(tmp + "-wal"); } catch {}
  }
});

test("grok -> T3 round-trip with full schema", { skip: !HAS_DATA.grok || !HAS_DATA.t3 }, async () => {
  const { listSessions, readSession } = await import("../src/parsers/grok.mjs");
  const { writeT3 } = await import("../src/injectors/t3.mjs");
  const Database = (await import("better-sqlite3")).default;
  const live = path.join(os.homedir(), ".t3", "userdata", "state.sqlite");
  const src = new Database(live, { readonly: true });
  const createStmts = src.prepare("SELECT sql FROM sqlite_master WHERE type IN ('table') AND name LIKE 'projection_%' AND sql IS NOT NULL").all();
  const indexStmts = src.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name LIKE 'projection_%' AND sql IS NOT NULL").all();
  src.close();
  const tmp = path.join(os.tmpdir(), `chatport-t3-rt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.sqlite`);
  const fresh = new Database(tmp);
  fresh.pragma("journal_mode = WAL");
  for (const r of createStmts) fresh.exec(r.sql + ";");
  for (const r of indexStmts) fresh.exec(r.sql + ";");
  fresh.close();
  try {
    const grok = await pickGrok();
    const session = await readSession(grok.path);
    const r = await writeT3(session, tmp);
    const db = new Database(tmp, { readonly: true });
    const turns = db.prepare("SELECT COUNT(*) as n FROM projection_turns WHERE thread_id = ?").get(r.threadId).n;
    const userMsgs = db.prepare("SELECT COUNT(*) as n FROM projection_thread_messages WHERE thread_id = ? AND role = 'user'").get(r.threadId).n;
    const asstMsgs = db.prepare("SELECT COUNT(*) as n FROM projection_thread_messages WHERE thread_id = ? AND role = 'assistant'").get(r.threadId).n;
    const activities = db.prepare("SELECT COUNT(*) as n FROM projection_thread_activities WHERE thread_id = ?").get(r.threadId).n;
    const sessionRow = db.prepare("SELECT 1 FROM projection_thread_sessions WHERE thread_id = ?").get(r.threadId);
    db.close();
    assert.equal(turns, userMsgs, "turn count should equal user message count");
    assert.ok(asstMsgs > 0, "should have assistant messages");
    assert.ok(!!sessionRow, "session row should exist");
    assert.ok(activities > 0, "should have tool_call activities");
  } finally {
    try { fs.unlinkSync(tmp); fs.unlinkSync(tmp + "-shm"); fs.unlinkSync(tmp + "-wal"); } catch {}
  }
});
