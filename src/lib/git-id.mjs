import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

function hashFast(input) {
  return crypto.createHash("sha1").update(input).digest("hex");
}

export function gitRoot(cwd) {
  if (!cwd) return null;
  try {
    if (!fs.existsSync(path.join(cwd, ".git")) && !gitTopFromInside(cwd)) {
      return null;
    }
    return execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function gitTopFromInside(cwd) {
  try {
    return execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function gitRemoteUrl(cwd) {
  try {
    const out = execFileSync("git", ["-C", cwd, "remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

function normalizeRemoteUrl(input) {
  if (!input) return null;
  const value = input.trim();
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol === "file:") return null;
    return parts(parsed.hostname, parsed.pathname);
  } catch {
    const scp = value.match(/^([^@/:]+@)?([^/:]+):(.+)$/);
    if (scp) return parts(scp[2], scp[3]);
    return null;
  }
}

function parts(host, name) {
  if (!host || !name) return null;
  const pathname = name
    .replace(/^\/+/, "")
    .replace(/\.git\/?$/, "")
    .replace(/\/+$/, "");
  if (!pathname) return null;
  return `${host.toLowerCase()}/${pathname}`;
}

export function projectIdForDirectory(cwd) {
  const root = gitRoot(cwd);
  if (!root) return { id: "global", worktree: cwd ? path.parse(cwd).root : "/" };

  const cachedPath = path.join(root, "opencode");
  if (fs.existsSync(cachedPath)) {
    try {
      const cached = fs.readFileSync(cachedPath, "utf8").trim();
      if (cached) return { id: cached, worktree: root };
    } catch {}
  }

  const remoteUrl = gitRemoteUrl(root);
  if (remoteUrl) {
    const norm = normalizeRemoteUrl(remoteUrl);
    if (norm) return { id: hashFast(`git-remote:${norm}`), worktree: root };
  }

  return { id: hashFast(root), worktree: root };
}
