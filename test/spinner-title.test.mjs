import test from "node:test";
import assert from "node:assert/strict";
import { spinner } from "../src/lib/spinner.mjs";
import { cleanForTitle, deriveTitle } from "../src/lib/title.mjs";

test("cleanForTitle strips Codex 'AGENTS.md instructions for <path>:' prefix", () => {
  const out = cleanForTitle("AGENTS.md instructions for /home/kristof/dev/Temp/blur-my-shell: real question");
  assert.equal(out, "real question");
});

test("cleanForTitle strips AGENTS.md prefix case-insensitively without colon", () => {
  const out = cleanForTitle("agents.md instructions for /tmp/proj\n\nactual ask");
  assert.equal(out, "actual ask");
});

test("cleanForTitle leaves normal text untouched", () => {
  const out = cleanForTitle("Refactor the spinner to use monotonic frames");
  assert.equal(out, "Refactor the spinner to use monotonic frames");
});

test("deriveTitle falls back to cwd basename when first message is only the AGENTS.md prefix", () => {
  const s = {
    messages: [
      { role: "user", text: "AGENTS.md instructions for /home/kristof/dev/Temp/blur-my-shell:", blocks: [] },
    ],
    cwd: "/home/kristof/dev/Temp/blur-my-shell",
  };
  assert.equal(deriveTitle(s), "blur-my-shell");
});

test("spinner tick advances monotonically (frame index never goes backward)", () => {
  const originalIsTTY = process.stdout.isTTY;
  const originalWrite = process.stdout.write.bind(process.stdout);
  const recorded = [];
  process.stdout.isTTY = true;
  process.stdout.write = (chunk) => {
    const s = String(chunk);
    if (s.startsWith("\r") && !s.includes("\x1b[2K")) {
      const m = s.match(/^\r(.) /);
      if (m) recorded.push(m[1]);
    }
    return true;
  };
  try {
    const sp = spinner("working");
    return new Promise((resolve) => {
      setTimeout(async () => {
        await sp.stop();
        process.stdout.write = originalWrite;
        process.stdout.isTTY = originalIsTTY;
        assert.ok(recorded.length >= 3, `expected several ticks, got ${recorded.length}`);
        const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
        for (let i = 1; i < recorded.length; i++) {
          const prev = FRAMES.indexOf(recorded[i - 1]);
          const cur = FRAMES.indexOf(recorded[i]);
          assert.ok(cur === (prev + 1) % FRAMES.length, `frame went backward: ${recorded[i - 1]} -> ${recorded[i]}`);
        }
        resolve();
      }, 400);
    });
  } catch (e) {
    process.stdout.write = originalWrite;
    process.stdout.isTTY = originalIsTTY;
    throw e;
  }
});

test("spinner success writes a heavy checkmark ✔ (U+2714) on stop", () => {
  const originalIsTTY = process.stdout.isTTY;
  const originalWrite = process.stdout.write.bind(process.stdout);
  const lines = [];
  process.stdout.isTTY = false;
  process.stdout.write = (chunk) => {
    lines.push(String(chunk));
    return true;
  };
  return (async () => {
    const sp = spinner("loading");
    await sp.success("done");
    process.stdout.write = originalWrite;
    process.stdout.isTTY = originalIsTTY;
    const out = lines.join("");
    assert.match(out, /✔/, "expected heavy checkmark ✔ in success output");
    assert.doesNotMatch(out, /✓\sdone/, "should not use thin checkmark ✓");
  })();
});
