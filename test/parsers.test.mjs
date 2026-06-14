import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import fsSync from "node:fs";

const HAS_DATA = {
  codex: fsSync.existsSync(path.join(os.homedir(), ".codex", "sessions")),
  opencode: fsSync.existsSync(path.join(os.homedir(), ".local", "share", "opencode", "opencode.db")),
  grok: fsSync.existsSync(path.join(os.homedir(), ".grok", "sessions")),
  t3: fsSync.existsSync(path.join(os.homedir(), ".t3", "userdata", "state.sqlite")),
  synara: fsSync.existsSync(path.join(os.homedir(), ".synara", "userdata", "state.sqlite")),
};

test("codex parser handles rollout files", { skip: !HAS_DATA.codex }, async () => {
  const { listSessions, readSession } = await import("../src/parsers/codex.mjs");
  const root = path.join(os.homedir(), ".codex", "sessions");
  const sessions = await listSessions(root);
  assert.ok(sessions.length > 0, "should find at least one codex session");
  const first = sessions[0];
  assert.ok(first.id);
  assert.ok(first.path);
  const ucf = await readSession(first.path);
  assert.equal(ucf.source, "codex");
  assert.ok(ucf.messages.length > 0);
  const textMsg = ucf.messages.find((m) => m.role === "user" || m.role === "assistant");
  assert.ok(textMsg, "should have a user or assistant message");
});

test("opencode parser reads SQLite", { skip: !HAS_DATA.opencode }, async () => {
  const { listSessions, readSession } = await import("../src/parsers/opencode.mjs");
  const dbPath = path.join(os.homedir(), ".local", "share", "opencode", "opencode.db");
  const sessions = listSessions(dbPath);
  assert.ok(sessions.length > 0);
  const withMsg = sessions.find((s) => s.title) || sessions[0];
  const ucf = readSession(dbPath, withMsg.id);
  assert.equal(ucf.source, "opencode");
  assert.ok(ucf.messages.length > 0);
});

test("grok parser finds session directories", { skip: !HAS_DATA.grok }, async () => {
  const { listSessions, readSession } = await import("../src/parsers/grok.mjs");
  const root = path.join(os.homedir(), ".grok", "sessions");
  const sessions = await listSessions(root);
  assert.ok(sessions.length > 0);
  const real = sessions.find((s) => s.numChatMessages > 1) || sessions[0];
  const ucf = await readSession(real.path);
  assert.equal(ucf.source, "grok");
});

test("t3 parser reads state.sqlite", { skip: !HAS_DATA.t3 }, async () => {
  const { listThreads, readThread } = await import("../src/parsers/t3.mjs");
  const dbPath = path.join(os.homedir(), ".t3", "userdata", "state.sqlite");
  const threads = listThreads(dbPath);
  assert.ok(threads.length > 0);
  const ucf = readThread(dbPath, threads[0].id);
  assert.equal(ucf.source, "t3");
});

test("synara parser reads state.sqlite", { skip: !HAS_DATA.synara }, async () => {
  const { listThreads, readThread } = await import("../src/parsers/synara.mjs");
  const dbPath = path.join(os.homedir(), ".synara", "userdata", "state.sqlite");
  const threads = listThreads(dbPath);
  assert.ok(threads.length > 0);
  const ucf = readThread(dbPath, threads[0].id);
  assert.equal(ucf.source, "synara");
  assert.ok(ucf.metadata.synara);
});
