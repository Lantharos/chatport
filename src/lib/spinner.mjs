const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const TICK_INTERVAL_MS = 80;
const TICK = "\x1b[32m✔\x1b[0m";
const CROSS = "\x1b[31m✘\x1b[0m";

let activeCount = 0;
let currentTimer = null;
let currentText = "";
let frameIndex = 0;

function hideCursor() {
  if (process.stdout.isTTY) process.stdout.write("\x1b[?25l");
}
function showCursor() {
  if (process.stdout.isTTY) process.stdout.write("\x1b[?25h");
}

function tick(stream) {
  if (activeCount === 0) return;
  const frame = FRAMES[frameIndex % FRAMES.length];
  frameIndex++;
  stream.write(`\r${frame} ${currentText}`);
}

export function spinner(text, { minMs = 0 } = {}) {
  const startedAt = Date.now();

  if (!process.stdout.isTTY) {
    process.stdout.write(`· ${text}\n`);
    let resolveOuter;
    const done = new Promise((r) => (resolveOuter = r));
    return {
      update(newText) { process.stdout.write(`· ${newText}\n`); currentText = newText; },
      stop(finalText) { if (finalText) process.stdout.write(`${TICK} ${finalText}\n`); resolveOuter(); },
      success(finalText) { if (finalText) process.stdout.write(`${TICK} ${finalText}\n`); resolveOuter(); },
      fail(finalText) { if (finalText) process.stdout.write(`${CROSS} ${finalText}\n`); resolveOuter(); },
      done,
    };
  }

  hideCursor();
  currentText = text;
  activeCount++;
  if (!currentTimer) {
    frameIndex = 0;
    currentTimer = setInterval(() => tick(process.stdout), TICK_INTERVAL_MS);
  }

  let resolveOuter;
  const done = new Promise((r) => (resolveOuter = r));

  function clear() {
    process.stdout.write("\r\x1b[2K");
  }

  function maybeDelay() {
    const elapsed = Date.now() - startedAt;
    if (elapsed >= minMs) return Promise.resolve();
    return new Promise((r) => setTimeout(r, minMs - elapsed));
  }

  return {
    update(newText) {
      currentText = newText;
    },
    async success(finalText) {
      const msg = finalText || currentText;
      await maybeDelay();
      clear();
      process.stdout.write(`${TICK} ${msg}\n`);
      finish();
    },
    async stop(finalText) {
      const msg = finalText || currentText;
      await maybeDelay();
      clear();
      process.stdout.write(`${TICK} ${msg}\n`);
      finish();
    },
    async fail(finalText) {
      const msg = finalText || currentText;
      await maybeDelay();
      clear();
      process.stdout.write(`${CROSS} ${msg}\n`);
      finish();
    },
    done,
  };

  function finish() {
    activeCount--;
    if (activeCount <= 0) {
      activeCount = 0;
      if (currentTimer) { clearInterval(currentTimer); currentTimer = null; }
      showCursor();
    }
    resolveOuter();
  }
}

export async function withSpinner(text, fn, opts = {}) {
  const sp = spinner(text, opts);
  try {
    const result = await fn(sp);
    await sp.success();
    return result;
  } catch (e) {
    await sp.fail(e?.message || String(e));
    throw e;
  }
}
