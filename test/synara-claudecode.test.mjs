import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HAS_DATA = {
  codex: fs.existsSync(path.join(os.homedir(), ".codex", "sessions")),
  grok: fs.existsSync(path.join(os.homedir(), ".grok", "sessions")),
  t3: fs.existsSync(path.join(os.homedir(), ".t3", "userdata", "state.sqlite")),
  synara: fs.existsSync(path.join(os.homedir(), ".synara", "userdata", "state.sqlite")),
};

function tmpFile(prefix, ext = ".jsonl") {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}${ext}`);
}

function rmTmp(target) {
  try { fs.rmSync(target, { recursive: true, force: true }); } catch {}
  try { fs.unlinkSync(target); } catch {}
}

async function makeFreshSqlite(livePath, namePrefix) {
  const Database = (await import("better-sqlite3")).default;
  const tmp = path.join(os.tmpdir(), `${namePrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.sqlite`);
  const src = new Database(livePath, { readonly: true });
  const createStmts = src.prepare("SELECT sql FROM sqlite_master WHERE type IN ('table') AND name LIKE 'projection_%' AND sql IS NOT NULL").all();
  const indexStmts = src.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name LIKE 'projection_%' AND sql IS NOT NULL").all();
  src.close();
  const fresh = new Database(tmp);
  fresh.pragma("journal_mode = WAL");
  for (const r of createStmts) fresh.exec(r.sql + ";");
  for (const r of indexStmts) fresh.exec(r.sql + ";");
  fresh.close();
  return tmp;
}

function buildSyntheticClaudeSession() {
  const sessionId = "synthetic-claude-" + Math.random().toString(36).slice(2, 10);
  const cwd = "/home/synthetic/project";
  const lines = [
    { type: "permission-mode", permissionMode: "default", sessionId },
    { type: "custom-title", customTitle: "Synthetic Claude session", sessionId },
    { type: "agent-name", agentName: "Synthetic Claude session", sessionId },
    {
      parentUuid: null, isSidechain: false, type: "user", isMeta: false,
      message: { role: "user", content: "Can you make a sample Python script?" },
      uuid: "u-1", timestamp: "2026-06-15T12:00:00.000Z", sessionId, cwd,
    },
    {
      parentUuid: "u-1", isSidechain: false, type: "assistant",
      message: {
        id: "a-1", type: "message", role: "assistant", model: "claude-sonnet-4-5",
        content: [{ type: "text", text: "Sure, let me check the repo first." }, { type: "thinking", thinking: "The user wants a Python script. I should look at the repo first." }],
        stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 100, output_tokens: 50 },
      },
      requestId: "req-1", uuid: "a-1", timestamp: "2026-06-15T12:00:05.000Z", sessionId, cwd,
    },
    {
      parentUuid: "a-1", isSidechain: false, type: "assistant",
      message: {
        id: "a-2", type: "message", role: "assistant", model: "claude-sonnet-4-5",
        content: [{ type: "text", text: "Running ls." }, { type: "tool_use", id: "call_ls1", name: "Bash", input: { command: "ls -la" } }],
        stop_reason: "tool_use", stop_sequence: null,
      },
      requestId: "req-2", uuid: "a-2", timestamp: "2026-06-15T12:00:10.000Z", sessionId, cwd,
    },
    {
      parentUuid: "a-2", isSidechain: false, type: "user", isMeta: false,
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call_ls1", content: "file.txt\ndir/", is_error: false }] },
      uuid: "u-2", timestamp: "2026-06-15T12:00:11.000Z", sessionId, cwd,
    },
    {
      parentUuid: "u-2", isSidechain: false, type: "assistant",
      message: {
        id: "a-3", type: "message", role: "assistant", model: "claude-sonnet-4-5",
        content: [{ type: "text", text: "Here's the script: ```python\nprint('hi')\n```" }],
        stop_reason: "end_turn", stop_sequence: null,
      },
      requestId: "req-3", uuid: "a-3", timestamp: "2026-06-15T12:00:15.000Z", sessionId, cwd,
    },
    {
      parentUuid: "a-3", isSidechain: false, type: "user", isMeta: false,
      message: { role: "user", content: "thanks!" },
      uuid: "u-3", timestamp: "2026-06-15T12:01:00.000Z", sessionId, cwd,
    },
  ];
  return { sessionId, cwd, lines };
}

function writeClaudeJsonl(target, lines) {
  const cwd = lines[0].cwd || "";
  const enc = "-" + cwd.replace(/^\/+/, "").replace(/\//g, "-");
  const sessionId = lines[0].sessionId || "synthetic";
  const dir = path.join(path.dirname(target), enc, "synthetic-test");
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, sessionId + ".jsonl");
  fs.writeFileSync(out, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return out;
}

test("claudecode parser reads synthetic session correctly", async () => {
  const { sessionId, cwd, lines } = buildSyntheticClaudeSession();
  const target = tmpFile("claude-test");
  try {
    const file = writeClaudeJsonl(target, lines);
    const { readSession } = await import("../src/parsers/claudecode.mjs");
    const s = await readSession(file);
    assert.equal(s.source, "claudecode");
    assert.equal(s.sessionId, sessionId);
    assert.equal(s.cwd, cwd);
    assert.equal(s.title, "Synthetic Claude session");
    const roleCount = {};
    for (const m of s.messages) roleCount[m.role] = (roleCount[m.role] || 0) + 1;
    assert.ok(roleCount.user >= 2, "should have at least 2 user envelopes (incl. tool_result)");
    assert.ok(roleCount.assistant >= 3, "should have at least 3 assistant envelopes");
    const toolCallBlocks = s.messages.reduce((n, m) => n + (m.blocks || []).filter((b) => b.type === "tool_call").length, 0);
    assert.equal(toolCallBlocks, 1, "should have 1 tool_call (Bash)");
    const reasoningBlocks = s.messages.reduce((n, m) => n + (m.blocks || []).filter((b) => b.type === "reasoning").length, 0);
    assert.equal(reasoningBlocks, 1, "should have 1 reasoning (thinking) block");
    const toolResultBlocks = s.messages.reduce((n, m) => n + (m.blocks || []).filter((b) => b.type === "tool_result").length, 0);
    assert.equal(toolResultBlocks, 1, "should have 1 tool_result block");
  } finally { rmTmp(target); rmTmp(path.dirname(path.dirname(target))); }
});

test("claudecode round-trip preserves messages, tool_calls, and reasoning", async () => {
  const { lines } = buildSyntheticClaudeSession();
  const target = tmpFile("claude-rt-test");
  try {
    const inFile = writeClaudeJsonl(target, lines);
    const { readSession } = await import("../src/parsers/claudecode.mjs");
    const { writeClaudeCode } = await import("../src/injectors/claudecode.mjs");
    const session = await readSession(inFile);
    const outFile = tmpFile("claude-out", ".jsonl");
    await writeClaudeCode(session, outFile);
    const round = await readSession(outFile);
    const srcToolCalls = session.messages.reduce((n, m) => n + (m.blocks || []).filter((b) => b.type === "tool_call").length, 0);
    const dstToolCalls = round.messages.reduce((n, m) => n + (m.blocks || []).filter((b) => b.type === "tool_call").length, 0);
    assert.equal(dstToolCalls, srcToolCalls, "tool_call count should round-trip");
    const srcReasoning = session.messages.reduce((n, m) => n + (m.blocks || []).filter((b) => b.type === "reasoning").length, 0);
    const dstReasoning = round.messages.reduce((n, m) => n + (m.blocks || []).filter((b) => b.type === "reasoning").length, 0);
    assert.equal(dstReasoning, srcReasoning, "reasoning count should round-trip");
    assert.equal(round.messages.length, session.messages.length, "message count should round-trip");
    rmTmp(outFile);
  } finally { rmTmp(target); rmTmp(path.dirname(path.dirname(target))); }
});

test("codex -> claudecode preserves tool_calls (cross-port)", { skip: !HAS_DATA.codex }, async () => {
  const { listSessions, readSession } = await import("../src/parsers/codex.mjs");
  const { readSession: claudeRead } = await import("../src/parsers/claudecode.mjs");
  const { writeClaudeCode } = await import("../src/injectors/claudecode.mjs");
  const all = await listSessions(path.join(os.homedir(), ".codex", "sessions"));
  const src = all[0];
  const outFile = tmpFile("claude-from-codex", ".jsonl");
  try {
    await writeClaudeCode(await readSession(src.path), outFile);
    const round = await claudeRead(outFile);
    const srcToolCalls = (await readSession(src.path)).messages.reduce((n, m) => n + (m.blocks || []).filter((b) => b.type === "tool_call").length, 0);
    const dstToolCalls = round.messages.reduce((n, m) => n + (m.blocks || []).filter((b) => b.type === "tool_call").length, 0);
    assert.equal(dstToolCalls, srcToolCalls, "every codex tool_call should produce a claudecode tool_use that reads back as tool_call");
  } finally { rmTmp(outFile); }
});

test("grok -> claudecode preserves tool_calls (cross-port)", { skip: !HAS_DATA.grok }, async () => {
  const { listSessions, readSession } = await import("../src/parsers/grok.mjs");
  const { readSession: claudeRead } = await import("../src/parsers/claudecode.mjs");
  const { writeClaudeCode } = await import("../src/injectors/claudecode.mjs");
  const all = await listSessions(path.join(os.homedir(), ".grok", "sessions"));
  const src = all.find((s) => (s.numChatMessages || 0) > 1) || all[0];
  const outFile = tmpFile("claude-from-grok", ".jsonl");
  try {
    await writeClaudeCode(await readSession(src.path), outFile);
    const round = await claudeRead(outFile);
    const srcToolCalls = (await readSession(src.path)).messages.reduce((n, m) => n + (m.blocks || []).filter((b) => b.type === "tool_call").length, 0);
    const dstToolCalls = round.messages.reduce((n, m) => n + (m.blocks || []).filter((b) => b.type === "tool_call").length, 0);
    assert.equal(dstToolCalls, srcToolCalls, "every grok tool_call should produce a claudecode tool_use that reads back as tool_call");
  } finally { rmTmp(outFile); }
});

test("synara -> synara round-trip with full schema (live DB)", { skip: !HAS_DATA.synara }, async () => {
  const { listThreads, readThread } = await import("../src/parsers/synara.mjs");
  const { writeSynara } = await import("../src/injectors/synara.mjs");
  const live = path.join(os.homedir(), ".synara", "userdata", "state.sqlite");
  const all = listThreads(live);
  const src = all[0];
  const tmp = await makeFreshSqlite(live, "chatport-synara-rt");
  try {
    const r = await writeSynara(await readThread(live, src.id), tmp);
    assert.ok(r.turnsCreated > 0, "should create at least one turn");
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(tmp, { readonly: true });
    const turns = db.prepare("SELECT COUNT(*) as n FROM projection_turns WHERE thread_id = ?").get(r.threadId).n;
    const userMsgs = db.prepare("SELECT COUNT(*) as n FROM projection_thread_messages WHERE thread_id = ? AND role = 'user'").get(r.threadId).n;
    const asstMsgs = db.prepare("SELECT COUNT(*) as n FROM projection_thread_messages WHERE thread_id = ? AND role = 'assistant'").get(r.threadId).n;
    const sess = db.prepare("SELECT status FROM projection_thread_sessions WHERE thread_id = ?").get(r.threadId);
    db.close();
    assert.equal(turns, userMsgs, "turn count should equal user count");
    assert.ok(asstMsgs > 0, "should have assistant messages");
    assert.ok(sess, "should have a session row");
  } finally { try { fs.unlinkSync(tmp); fs.unlinkSync(tmp + "-shm"); fs.unlinkSync(tmp + "-wal"); } catch {} }
});

test("codex -> synara cross-port with full schema", { skip: !HAS_DATA.codex || !HAS_DATA.synara }, async () => {
  const { listSessions, readSession } = await import("../src/parsers/codex.mjs");
  const { writeSynara } = await import("../src/injectors/synara.mjs");
  const Database = (await import("better-sqlite3")).default;
  const live = path.join(os.homedir(), ".synara", "userdata", "state.sqlite");
  const tmp = await makeFreshSqlite(live, "chatport-synara-c2s");
  try {
    const all = await listSessions(path.join(os.homedir(), ".codex", "sessions"));
    const src = all[0];
    const r = await writeSynara(await readSession(src.path), tmp);
    const db = new Database(tmp, { readonly: true });
    const turns = db.prepare("SELECT COUNT(*) as n FROM projection_turns WHERE thread_id = ?").get(r.threadId).n;
    const userMsgs = db.prepare("SELECT COUNT(*) as n FROM projection_thread_messages WHERE thread_id = ? AND role = 'user'").get(r.threadId).n;
    const sourceValues = db.prepare("SELECT DISTINCT source FROM projection_thread_messages WHERE thread_id = ?").all(r.threadId).map(row => row.source);
    db.close();
    assert.ok(turns > 0, "should have turns");
    assert.equal(turns, userMsgs, "turns == user count");
    assert.ok(sourceValues.includes("imported"), "imported messages should have source='imported'");
  } finally { try { fs.unlinkSync(tmp); fs.unlinkSync(tmp + "-shm"); fs.unlinkSync(tmp + "-wal"); } catch {} }
});
