#!/usr/bin/env node
import("../src/index.mjs").catch((err) => {
  console.error("chatport: fatal:", err?.message || err);
  process.exit(1);
});
