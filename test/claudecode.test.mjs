import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import fsSync from "node:fs";

import { listSessions, readSession } from "../src/parsers/claudecode.mjs";
import { writeClaudeCode } from "../src/injectors/claudecode.mjs";

const HAS_DATA = fsSync.existsSync(path.join(os.homedir(), ".claude", "projects"));

function tmpRoot() {
  return fsSync.mkdtempSync(path.join(os.tmpdir(), "chatport-claudecode-"));
}

function writeFixture(root, projectKey, sessionId, envelopes) {
  const dir = path.join(root, projectKey);
  fsSync.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  fsSync.writeFileSync(file, envelopes.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return file;
}

const SESSION_ID = "sess-abc-123";

const SAMPLE_ENVELOPES = [
  {
    type: "permission-mode",
    permissionMode: "default",
    sessionId: SESSION_ID,
  },
  {
    parentUuid: null,
    isSidechain: false,
    promptId: "p1",
    type: "user",
    message: { role: "user", content: "Refactor the parser to use a token stream." },
    isMeta: false,
    uuid: "u1",
    timestamp: "2026-06-10T10:00:00.000Z",
    permissionMode: "default",
    userType: "external",
    entrypoint: "cli",
    cwd: "/Users/dev/proj",
    sessionId: SESSION_ID,
    version: "2.1.81",
    gitBranch: "main",
    slug: "iridescent-scribbling-noodle",
  },
  {
    parentUuid: "u1",
    isSidechain: false,
    message: {
      id: "msg_a1",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [
        { type: "thinking", thinking: "The user wants a token-stream refactor." },
        { type: "text", text: "I'll start by inspecting the current lexer." },
        {
          type: "tool_use",
          id: "toolu_1",
          name: "Read",
          input: { file_path: "/Users/dev/proj/parser.mjs" },
        },
      ],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 15000, output_tokens: 200 },
    },
    requestId: "req_1",
    type: "assistant",
    uuid: "a1",
    timestamp: "2026-06-10T10:00:05.000Z",
    userType: "external",
    entrypoint: "cli",
    cwd: "/Users/dev/proj",
    sessionId: SESSION_ID,
    version: "2.1.81",
    gitBranch: "main",
  },
  {
    parentUuid: "a1",
    isSidechain: false,
    promptId: "p1",
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_1",
          content: "const x = 1;\nconst y = 2;",
          is_error: false,
        },
      ],
    },
    uuid: "u2",
    timestamp: "2026-06-10T10:00:10.000Z",
    sourceToolAssistantUUID: "a1",
    userType: "external",
    entrypoint: "cli",
    cwd: "/Users/dev/proj",
    sessionId: SESSION_ID,
    version: "2.1.81",
  },
  {
    parentUuid: "u2",
    isSidechain: false,
    message: {
      id: "msg_a2",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text: "Done — refactored to a token stream." }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 15000, output_tokens: 400 },
    },
    requestId: "req_2",
    type: "assistant",
    uuid: "a2",
    timestamp: "2026-06-10T10:00:15.000Z",
    userType: "external",
    entrypoint: "cli",
    cwd: "/Users/dev/proj",
    sessionId: SESSION_ID,
    version: "2.1.81",
  },
  {
    parentUuid: "a2",
    isSidechain: false,
    type: "file-history-snapshot",
    messageId: "a2",
    snapshot: { messageId: "a2", trackedFileBackups: {}, timestamp: "2026-06-10T10:00:15.000Z" },
    isSnapshotUpdate: false,
    uuid: "f1",
    timestamp: "2026-06-10T10:00:15.500Z",
  },
  {
    parentUuid: "a2",
    isSidechain: false,
    type: "progress",
    data: { type: "agent_progress", message: { type: "user", message: { role: "user", content: [{ type: "text", text: "explore" }] } }, agentId: "abc123" },
    toolUseID: "toolu_x",
    parentToolUseID: "toolu_1",
    uuid: "p1",
    timestamp: "2026-06-10T10:00:16.000Z",
  },
  {
    type: "custom-title",
    customTitle: "Refactor parser to token stream",
    sessionId: SESSION_ID,
    uuid: "t1",
    timestamp: "2026-06-10T10:00:20.000Z",
  },
  {
    type: "agent-name",
    agentName: "Refactor parser to token stream",
    sessionId: SESSION_ID,
    uuid: "t2",
    timestamp: "2026-06-10T10:00:20.100Z",
  },
  {
    type: "last-prompt",
    lastPrompt: "Refactor the parser to use a token stream.",
    sessionId: SESSION_ID,
    uuid: "lp1",
    timestamp: "2026-06-10T10:00:25.000Z",
  },
];

test("claudecode listSessions finds fixture, decodes project cwd, picks up custom-title", async () => {
  const root = tmpRoot();
  try {
    writeFixture(root, "-Users-dev-proj", SESSION_ID, SAMPLE_ENVELOPES);
    const sessions = listSessions(root);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].id, SESSION_ID);
    assert.equal(sessions[0].source, "claudecode");
    assert.equal(sessions[0].cwd, "/Users/dev/proj");
    assert.equal(sessions[0].title, "Refactor parser to token stream", "should use custom-title over first user message");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("claudecode readSession parses text, tool calls, tool results, reasoning, and metadata", async () => {
  const root = tmpRoot();
  try {
    writeFixture(root, "-Users-dev-proj", SESSION_ID, SAMPLE_ENVELOPES);
    const sessions = listSessions(root);
    const ucf = readSession(sessions[0].path);

    assert.equal(ucf.source, "claudecode");
    assert.equal(ucf.sessionId, SESSION_ID);
    assert.equal(ucf.cwd, "/Users/dev/proj");
    assert.equal(ucf.model, "claude-sonnet-4-6");
    assert.equal(ucf.title, "Refactor parser to token stream");

    assert.equal(ucf.metadata.claudecode.slug, "iridescent-scribbling-noodle");
    assert.equal(ucf.metadata.claudecode.permissionMode, "default");
    assert.equal(ucf.metadata.claudecode.lastPrompt, "Refactor the parser to use a token stream.");
    assert.equal(ucf.metadata.claudecode.skipped.fileHistorySnapshot, 1);
    assert.equal(ucf.metadata.claudecode.skipped.progress, 1);

    const userMsg = ucf.messages.find((m) => m.role === "user" && m.text.startsWith("Refactor"));
    assert.ok(userMsg, "should have the first user message");
    assert.equal(userMsg.timestamp, Date.parse("2026-06-10T10:00:00.000Z"));
    assert.equal(userMsg.metadata.gitBranch, "main");
    assert.equal(userMsg.metadata.promptId, "p1");

    const toolResultMsg = ucf.messages.find((m) => m.blocks.some((b) => b.type === "tool_result"));
    assert.ok(toolResultMsg);
    const trBlock = toolResultMsg.blocks.find((b) => b.type === "tool_result");
    assert.equal(trBlock.toolCallId, "toolu_1");
    assert.match(trBlock.text, /const x/);
    assert.equal(toolResultMsg.metadata.sourceToolAssistantUUID, "a1");

    const assistantWithTool = ucf.messages.find(
      (m) => m.role === "assistant" && m.blocks.some((b) => b.type === "tool_call"),
    );
    assert.ok(assistantWithTool);
    const tcBlock = assistantWithTool.blocks.find((b) => b.type === "tool_call");
    assert.equal(tcBlock.tool, "Read");
    assert.equal(tcBlock.callId, "toolu_1");
    assert.deepEqual(tcBlock.args, { file_path: "/Users/dev/proj/parser.mjs" });
    assert.equal(assistantWithTool.metadata.requestId, "req_1");
    assert.deepEqual(assistantWithTool.metadata.usage, { input_tokens: 15000, output_tokens: 200 });

    const reasoningBlock = assistantWithTool.blocks.find((b) => b.type === "reasoning");
    assert.ok(reasoningBlock);
    assert.match(reasoningBlock.text, /token-stream/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("claudecode parser skips isMeta user envelopes, progress, system, snapshots", async () => {
  const root = tmpRoot();
  try {
    writeFixture(root, "-Users-dev-proj", "sess-meta", [
      { type: "permission-mode", permissionMode: "default", sessionId: "sess-meta" },
      {
        parentUuid: null,
        type: "user",
        isMeta: true,
        message: { role: "user", content: "<local-command-caveat>warmup</local-command-caveat>" },
        uuid: "m1",
        timestamp: "2026-06-10T09:00:00.000Z",
        sessionId: "sess-meta",
      },
      {
        parentUuid: "m1",
        type: "file-history-snapshot",
        messageId: "m1",
        snapshot: { messageId: "m1", trackedFileBackups: {} },
        isSnapshotUpdate: false,
        uuid: "f1",
        timestamp: "2026-06-10T09:00:01.000Z",
      },
      {
        parentUuid: "f1",
        type: "progress",
        data: { type: "agent_progress", agentId: "x", prompt: "explore" },
        toolUseID: "toolu_x",
        parentToolUseID: "toolu_p",
        uuid: "p1",
        timestamp: "2026-06-10T09:00:01.500Z",
      },
      {
        parentUuid: "p1",
        type: "system",
        subtype: "turn_duration",
        durationMs: 1200,
        uuid: "s1",
        timestamp: "2026-06-10T09:00:02.000Z",
        sessionId: "sess-meta",
        isMeta: false,
      },
      {
        parentUuid: "s1",
        type: "user",
        message: { role: "user", content: "real question" },
        uuid: "u1",
        timestamp: "2026-06-10T09:00:02.500Z",
        sessionId: "sess-meta",
      },
    ]);
    const sessions = listSessions(root);
    const ucf = readSession(sessions[0].path);
    const userMsgs = ucf.messages.filter((m) => m.role === "user");
    assert.equal(userMsgs.length, 1);
    assert.equal(userMsgs[0].text, "real question");
    assert.equal(ucf.metadata.claudecode.skipped.fileHistorySnapshot, 1);
    assert.equal(ucf.metadata.claudecode.skipped.progress, 1);
    assert.equal(ucf.metadata.claudecode.skipped.system, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("claudecode writeSession emits real-schema envelopes and preserves usage + model", async () => {
  const root = tmpRoot();
  try {
    writeFixture(root, "-Users-dev-proj", SESSION_ID, SAMPLE_ENVELOPES);
    const sessions = listSessions(root);
    const ucf = readSession(sessions[0].path);

    const outFile = path.join(root, "out.jsonl");
    await writeClaudeCode(ucf, outFile);

    const raw = fsSync.readFileSync(outFile, "utf-8");
    const lines = raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const types = lines.map((l) => l.type);

    assert.ok(types.includes("permission-mode"));
    assert.ok(types.includes("user"));
    assert.ok(types.includes("assistant"));
    assert.ok(types.includes("custom-title"));
    assert.ok(types.includes("agent-name"));
    assert.ok(!types.includes("summary"), "writer must not emit the nonexistent summary type");

    const firstAssistant = lines.find((l) => l.type === "assistant");
    assert.ok(firstAssistant.message.usage, "usage should be preserved when present in source");
    assert.equal(firstAssistant.message.usage.input_tokens, 15000);

    const firstUser = lines.find((l) => l.type === "user" && l.isMeta !== true);
    assert.ok(firstUser);
    assert.equal(firstUser.cwd, "/Users/dev/proj");
    assert.equal(firstUser.sessionId, SESSION_ID);

    const re = readSession(outFile);
    assert.equal(re.source, "claudecode");
    assert.equal(re.title, ucf.title, "custom-title should round-trip");
    const realUser = re.messages.find((m) => m.role === "user" && m.text.startsWith("Refactor"));
    assert.ok(realUser);

    const rtToolResult = re.messages.find((m) => m.blocks.some((b) => b.type === "tool_result"));
    assert.ok(rtToolResult, "tool_result user messages must survive the round trip");
    const rtTr = rtToolResult.blocks.find((b) => b.type === "tool_result");
    assert.equal(rtTr.toolCallId, "toolu_1");
    assert.match(rtTr.text, /const x/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("claudecode writeSession omits usage when source has none", async () => {
  const root = tmpRoot();
  try {
    const session = {
      version: 1,
      source: "test",
      sessionId: "s1",
      title: "minimal",
      model: "claude",
      cwd: "/x",
      createdAt: null,
      updatedAt: null,
      compaction: { mode: "none" },
      metadata: {},
      messages: [
        { role: "user", text: "hi", blocks: [{ type: "text", text: "hi" }], timestamp: Date.parse("2026-06-10T00:00:00Z") },
        { role: "assistant", text: "hello", blocks: [{ type: "text", text: "hello" }], timestamp: Date.parse("2026-06-10T00:00:01Z"), modelId: "claude", metadata: {} },
      ],
    };
    const outFile = path.join(root, "minimal.jsonl");
    await writeClaudeCode(session, outFile);
    const lines = fsSync.readFileSync(outFile, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const assistant = lines.find((l) => l.type === "assistant");
    assert.ok(assistant);
    assert.equal(assistant.message.usage, undefined, "usage should be omitted, not zeroed");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("claudecode dedupes streaming chunks and keeps the final stop_reason", async () => {
  const root = tmpRoot();
  try {
    writeFixture(root, "-Users-dev-proj", "sess-stream", [
      { type: "permission-mode", permissionMode: "default", sessionId: "sess-stream" },
      {
        parentUuid: null,
        type: "user",
        message: { role: "user", content: "stream test" },
        isMeta: false,
        uuid: "u1",
        timestamp: "2026-06-10T10:00:00.000Z",
        sessionId: "sess-stream",
      },
      {
        parentUuid: "u1",
        type: "assistant",
        message: { id: "msg_1", type: "message", role: "assistant", model: "claude", content: [{ type: "text", text: "Hello " }], stop_reason: null },
        requestId: "req_1",
        uuid: "a1",
        timestamp: "2026-06-10T10:00:01.000Z",
        sessionId: "sess-stream",
      },
      {
        parentUuid: "u1",
        type: "assistant",
        message: { id: "msg_1", type: "message", role: "assistant", model: "claude", content: [{ type: "text", text: "Hello world" }], stop_reason: "end_turn" },
        requestId: "req_1",
        uuid: "a2",
        timestamp: "2026-06-10T10:00:02.000Z",
        sessionId: "sess-stream",
      },
      {
        parentUuid: "u1",
        type: "assistant",
        message: { id: "msg_1", type: "message", role: "assistant", model: "claude", content: [{ type: "text", text: "Hello world!!" }], stop_reason: null },
        requestId: "req_1",
        uuid: "a3",
        timestamp: "2026-06-10T10:00:03.000Z",
        sessionId: "sess-stream",
      },
    ]);
    const sessions = listSessions(root);
    const ucf = readSession(sessions[0].path);
    const assistants = ucf.messages.filter((m) => m.role === "assistant");
    assert.equal(assistants.length, 1, "three streaming chunks should collapse to one message");
    assert.equal(assistants[0].text, "Hello world", "should keep the chunk with stop_reason set");
    assert.equal(assistants[0].metadata.requestId, "req_1");
    assert.equal(ucf.metadata.claudecode.streaming.uniqueRequestIds, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("claudecode merges subagent transcripts and tags them with agentId", async () => {
  const root = tmpRoot();
  try {
    const projectDir = path.join(root, "-Users-dev-proj");
    const sessionDir = path.join(projectDir, "sess-sub");
    fsSync.mkdirSync(path.join(sessionDir, "subagents"), { recursive: true });
    const main = path.join(projectDir, "sess-sub.jsonl");
    fsSync.writeFileSync(main, [
      JSON.stringify({ type: "permission-mode", permissionMode: "default", sessionId: "sess-sub" }),
      JSON.stringify({
        parentUuid: null, type: "user",
        message: { role: "user", content: "explore the project" },
        isMeta: false, uuid: "u1",
        timestamp: "2026-06-10T10:00:00.000Z", sessionId: "sess-sub",
      }),
      JSON.stringify({
        parentUuid: "u1", type: "assistant",
        message: { id: "m1", type: "message", role: "assistant", model: "claude", content: [
          { type: "tool_use", id: "toolu_x", name: "Agent", input: { prompt: "explore the project" } },
        ], stop_reason: "tool_use" },
        requestId: "r1", uuid: "a1", timestamp: "2026-06-10T10:00:01.000Z", sessionId: "sess-sub",
      }),
    ].join("\n") + "\n");

    const subJsonl = path.join(sessionDir, "subagents", "agent-abc.jsonl");
    const subMeta = path.join(sessionDir, "subagents", "agent-abc.meta.json");
    fsSync.writeFileSync(subJsonl, [
      JSON.stringify({
        parentUuid: null, isSidechain: true, type: "user",
        message: { role: "user", content: "subagent prompt" },
        uuid: "su1", timestamp: "2026-06-10T10:00:02.000Z", sessionId: "sub-sess-1", agentId: "abc",
      }),
      JSON.stringify({
        parentUuid: "su1", isSidechain: true, type: "assistant",
        message: { id: "sm1", type: "message", role: "assistant", model: "claude-haiku-4-5", content: [{ type: "text", text: "subagent answer" }], stop_reason: "end_turn" },
        requestId: "sr1", uuid: "sa1", timestamp: "2026-06-10T10:00:03.000Z", sessionId: "sub-sess-1", agentId: "abc",
      }),
    ].join("\n") + "\n");
    fsSync.writeFileSync(subMeta, JSON.stringify({ agentType: "Explore", description: "explore the project" }));

    const ucf = readSession(main);
    const subMsgs = ucf.messages.filter((m) => m.metadata?.subagent);
    assert.equal(subMsgs.length, 2, "should include both subagent user and assistant messages");
    assert.ok(subMsgs.every((m) => m.metadata.agentId === "abc"));
    assert.ok(subMsgs.find((m) => m.role === "assistant" && m.modelId === "claude-haiku-4-5"));
    assert.equal(ucf.metadata.claudecode.subagents.length, 1);
    assert.equal(ucf.metadata.claudecode.subagents[0].agentType, "Explore");
    assert.equal(ucf.metadata.claudecode.subagents[0].entryCount, 2);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("claudecode resolves externalized tool results from tool-results/<id>.json", async () => {
  const root = tmpRoot();
  try {
    const projectDir = path.join(root, "-Users-dev-proj");
    const sessionDir = path.join(projectDir, "sess-ext");
    fsSync.mkdirSync(path.join(sessionDir, "tool-results"), { recursive: true });
    const main = path.join(projectDir, "sess-ext.jsonl");
    fsSync.writeFileSync(main, [
      JSON.stringify({ type: "permission-mode", permissionMode: "default", sessionId: "sess-ext" }),
      JSON.stringify({
        parentUuid: "a1", type: "user",
        message: { role: "user", content: [
          { type: "tool_result", tool_use_id: "toolu_big", content: "tool-results/toolu_big.json", is_error: false },
        ] },
        uuid: "u1", timestamp: "2026-06-10T10:00:01.000Z", sessionId: "sess-ext", sourceToolAssistantUUID: "a1",
      }),
    ].join("\n") + "\n");
    fsSync.writeFileSync(path.join(sessionDir, "tool-results", "toolu_big.json"), JSON.stringify("huge tool output\n".repeat(200)));

    const ucf = readSession(main);
    const trMsg = ucf.messages.find((m) => m.blocks.some((b) => b.type === "tool_result"));
    assert.ok(trMsg);
    const tr = trMsg.blocks.find((b) => b.type === "tool_result");
    assert.equal(tr.toolCallId, "toolu_big");
    assert.equal(tr.externalized, true, "should mark the block as externalized");
    assert.match(tr.text, /huge tool output/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("claudecode surfaces progress entries as system messages and counts them in metadata", async () => {
  const root = tmpRoot();
  try {
    writeFixture(root, "-Users-dev-proj", "sess-prog", [
      { type: "permission-mode", permissionMode: "default", sessionId: "sess-prog" },
      {
        parentUuid: null, type: "user",
        message: { role: "user", content: "do the thing" },
        isMeta: false, uuid: "u1", timestamp: "2026-06-10T10:00:00.000Z", sessionId: "sess-prog",
      },
      {
        parentUuid: "u1", type: "progress",
        data: { type: "agent_progress", agentId: "agent-77", prompt: "search the codebase for foo" },
        toolUseID: "tu1", parentToolUseID: "tu0", uuid: "p1", timestamp: "2026-06-10T10:00:01.000Z", sessionId: "sess-prog",
      },
      {
        parentUuid: "p1", type: "progress",
        data: { type: "agent_progress", agentId: "agent-77", prompt: "summarize findings" },
        toolUseID: "tu2", parentToolUseID: "tu0", uuid: "p2", timestamp: "2026-06-10T10:00:02.000Z", sessionId: "sess-prog",
      },
    ]);
    const ucf = readSession(path.join(root, "-Users-dev-proj", "sess-prog.jsonl"));
    const prog = ucf.messages.filter((m) => m.metadata?.kind === "subagent-progress");
    assert.equal(prog.length, 2);
    assert.equal(prog[0].metadata.agentId, "agent-77");
    assert.match(prog[0].text, /search the codebase/);
    assert.equal(ucf.metadata.claudecode.skipped.progress, 2, "should be counted in metadata, not silently dropped");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("claudecode live data (skipped if ~/.claude/projects missing)", { skip: !HAS_DATA }, async () => {
  const root = path.join(os.homedir(), ".claude", "projects");
  const sessions = listSessions(root);
  if (sessions.length === 0) return;
  const ucf = readSession(sessions[0].path);
  assert.equal(ucf.source, "claudecode");
  assert.ok(ucf.messages.length > 0);
  assert.ok(ucf.metadata.claudecode, "should record per-source metadata");
});
