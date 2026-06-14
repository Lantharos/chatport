import test from "node:test";
import assert from "node:assert/strict";
import { emptySession, makeMessage, makeBlock, textOf, summarize, fromJSON, UCF_VERSION } from "../src/ucf.mjs";
import { toMarkdown } from "../src/injectors/markdown.mjs";
import { toClaudeMarkdown } from "../src/injectors/claude.mjs";

test("emptySession returns valid UCF", () => {
  const s = emptySession({ source: "test" });
  assert.equal(s.version, UCF_VERSION);
  assert.equal(s.source, "test");
  assert.equal(s.messages.length, 0);
});

test("makeMessage sets blocks and text", () => {
  const m = makeMessage({ role: "user", text: "hello" });
  assert.equal(m.role, "user");
  assert.equal(m.text, "hello");
  assert.equal(m.blocks.length, 1);
  assert.equal(m.blocks[0].type, "text");
});

test("makeMessage rejects invalid role", () => {
  assert.throws(() => makeMessage({ role: "hacker" }));
});

test("textOf joins text and reasoning blocks", () => {
  const blocks = [
    makeBlock("text", { text: "Hello" }),
    makeBlock("reasoning", { text: "thinking" }),
    makeBlock("tool_call", { tool: "bash" }),
  ];
  assert.equal(textOf(blocks), "Hello\nthinking");
});

test("summarize counts messages and tool calls", () => {
  const s = emptySession({ source: "test" });
  s.messages.push(makeMessage({ role: "user", text: "hi" }));
  s.messages.push(
    makeMessage({
      role: "assistant",
      text: "ok",
      blocks: [makeBlock("text", { text: "ok" }), makeBlock("tool_call", { tool: "bash" })],
    }),
  );
  const sum = summarize(s);
  assert.equal(sum.messageCount, 2);
  assert.equal(sum.roleCounts.user, 1);
  assert.equal(sum.roleCounts.assistant, 1);
  assert.equal(sum.toolCalls, 1);
});

test("toMarkdown includes role headers and tool calls", () => {
  const s = emptySession({ source: "test", title: "Test" });
  s.messages.push(makeMessage({ role: "user", text: "Hi" }));
  s.messages.push(
    makeMessage({
      role: "assistant",
      text: "calling tool",
      blocks: [makeBlock("text", { text: "calling tool" }), makeBlock("tool_call", { tool: "bash", args: { cmd: "ls" }, output: "file.txt" })],
    }),
  );
  const md = toMarkdown(s);
  assert.match(md, /# Test/);
  assert.match(md, /## 👤 User/);
  assert.match(md, /## 🤖 Assistant/);
  assert.match(md, /🔧 bash/);
  assert.match(md, /file\.txt/);
});

test("toMarkdown includes reasoning when --reasoning is passed via option", () => {
  const s = emptySession({ source: "test" });
  s.messages.push(
    makeMessage({
      role: "assistant",
      text: "answer",
      blocks: [makeBlock("reasoning", { text: "internal thoughts" }), makeBlock("text", { text: "answer" })],
    }),
  );
  const md = toMarkdown(s, { includeReasoning: true });
  assert.match(md, /<details>/);
  assert.match(md, /internal thoughts/);
});

test("toClaudeMarkdown emits tagged user/assistant/system blocks", () => {
  const s = emptySession({ source: "test" });
  s.messages.push(makeMessage({ role: "system", text: "you are claude" }));
  s.messages.push(makeMessage({ role: "user", text: "hi" }));
  s.messages.push(
    makeMessage({
      role: "assistant",
      text: "ok",
      blocks: [
        makeBlock("text", { text: "ok" }),
        makeBlock("tool_call", { tool: "bash", callId: "c1", args: { cmd: "ls" } }),
      ],
    }),
  );
  const md = toClaudeMarkdown(s);
  assert.match(md, /<system>/);
  assert.match(md, /<user>/);
  assert.match(md, /<assistant>/);
  assert.match(md, /<tool_use name="bash"/);
});

test("fromJSON accepts same-version and migrates older", () => {
  const s = emptySession({ source: "test", title: "x" });
  s.messages.push(makeMessage({ role: "user", text: "q" }));
  const json = JSON.parse(JSON.stringify(s));
  const restored = fromJSON(json);
  assert.equal(restored.version, UCF_VERSION);
  assert.equal(restored.messages.length, 1);
});
