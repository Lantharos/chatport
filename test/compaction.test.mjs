import test from "node:test";
import assert from "node:assert/strict";
import { detectCompaction, applyCompaction, truncateToTurns, MODES } from "../src/lib/compaction.mjs";
import { emptySession, makeMessage } from "../src/ucf.mjs";

function codexSession() {
  const s = emptySession({ source: "codex" });
  for (let i = 0; i < 10; i++) {
    s.messages.push(makeMessage({ role: "user", text: `q${i}` }));
    s.messages.push(makeMessage({ role: "assistant", text: `a${i}` }));
  }
  s.messages.push(
    makeMessage({
      role: "system",
      text: "<compaction>",
      metadata: {
        kind: "compaction",
        replacementHistory: [
          { type: "message", role: "user", content: [{ type: "input_text", text: "summary q" }] },
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "summary a" }] },
        ],
      },
    }),
  );
  for (let i = 10; i < 12; i++) {
    s.messages.push(makeMessage({ role: "user", text: `q${i}` }));
    s.messages.push(makeMessage({ role: "assistant", text: `a${i}` }));
  }
  return s;
}

function grokSession() {
  const s = emptySession({ source: "grok" });
  s.metadata.grok = {
    nextTraceTurn: 4,
    sessionSummary: "Earlier work on foo",
    generatedTitle: "Foo session",
    gitRootDir: "/home/me/proj",
    headBranch: "main",
  };
  for (let i = 0; i < 8; i++) {
    s.messages.push(makeMessage({ role: "user", text: `q${i}` }));
    s.messages.push(makeMessage({ role: "assistant", text: `a${i}` }));
  }
  return s;
}

test("detectCompaction returns session unchanged for unknown source", () => {
  const s = emptySession({ source: "unknown" });
  s.messages.push(makeMessage({ role: "user", text: "hi" }));
  detectCompaction(s);
  assert.equal(s.compaction.mode, "none");
});

test("codex compaction is detected and applied", () => {
  const s = codexSession();
  detectCompaction(s);
  assert.equal(s.compaction.mode, MODES.CODEX);
  assert.equal(s.compaction.count, 1);
  assert.ok(s.compaction.cutIndex > 0, "cutIndex should be > 0");
  assert.equal(s.compaction.replacement.length, 2);

  const before = s.messages.length;
  applyCompaction(s, { keep: "compacted" });
  assert.ok(s.messages.length < before, "should reduce messages");
  assert.equal(s.compaction.applied, "compacted");
  assert.equal(s.compaction.summaryCount, 2);
  assert.equal(s.compaction.keptCount, before - s.compaction.cutIndex);
  assert.equal(s.messages[0].role, "user");
  assert.equal(s.messages[0].text, "summary q");
});

test("codex compaction with --full-history keeps everything", () => {
  const s = codexSession();
  detectCompaction(s);
  const before = s.messages.length;
  applyCompaction(s, { keep: "full" });
  assert.equal(s.messages.length, before);
  assert.equal(s.compaction.applied, undefined);
});

test("codex summary-only mode keeps just the replacement", () => {
  const s = codexSession();
  detectCompaction(s);
  const before = s.messages.length;
  applyCompaction(s, { keep: "summary-only" });
  assert.equal(s.messages.length, 2);
  assert.equal(s.compaction.applied, "summary-only");
  assert.ok(before > 2);
});

test("grok compaction is detected and applied", () => {
  const s = grokSession();
  detectCompaction(s);
  assert.equal(s.compaction.mode, MODES.GROK);
  assert.equal(s.compaction.summaryTurns, 4);
  assert.equal(s.compaction.summaryText, "Earlier work on foo");
  assert.ok(s.compaction.cutIndex > 0, "cutIndex should be > 0");

  applyCompaction(s, { keep: "compacted" });
  assert.equal(s.compaction.applied, "compacted");
  assert.equal(s.compaction.summaryCount, 1);
  assert.ok(s.compaction.keptCount > 0, "should keep some recent messages");
  assert.equal(s.messages[0].role, "system");
  assert.match(s.messages[0].text, /compaction-summary/);
  assert.match(s.messages[0].text, /Foo session/);
});

test("grok compaction when nextTraceTurn exceeds actual turns", () => {
  const s = grokSession();
  s.metadata.grok.nextTraceTurn = 100;
  detectCompaction(s);
  assert.ok(s.compaction.summaryTurns < 8);
  applyCompaction(s, { keep: "compacted" });
  assert.ok(s.compaction.keptCount > 0);
});

test("grok with no summaryText uses default summary message", () => {
  const s = grokSession();
  s.metadata.grok.sessionSummary = "";
  s.metadata.grok.nextTraceTurn = 2;
  detectCompaction(s);
  applyCompaction(s, { keep: "compacted" });
  assert.match(s.messages[0].text, /The first 2 user turn/);
});

test("truncateToTurns keeps last N user turns", () => {
  const s = codexSession();
  const before = s.messages.length;
  truncateToTurns(s, undefined, 3);
  const userTurns = s.messages.filter((m) => m.role === "user").length;
  assert.equal(userTurns, 3);
  assert.ok(s.messages.length < before, "should reduce message count");
});

test("truncateToTurns skips first N user turns", () => {
  const s = codexSession();
  truncateToTurns(s, 5, undefined);
  const userTurns = s.messages.filter((m) => m.role === "user").length;
  assert.ok(userTurns <= 8);
  assert.ok(s.messages.length > 0);
});

test("compaction summary carries source metadata", () => {
  const s = codexSession();
  detectCompaction(s);
  applyCompaction(s, { keep: "compacted" });
  const summaryMsgs = s.messages.filter((m) => m.metadata?.fromCompaction);
  assert.ok(summaryMsgs.length > 0);
});
