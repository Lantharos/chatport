const MAX_TITLE_LEN = 64;

export function deriveTitle(session) {
  if (session.title && session.title.trim().length > 0) return session.title;

  const firstUser = session.messages.find((m) => m.role === "user");
  if (firstUser) {
    const raw = firstUser.text || (firstUser.blocks?.find((b) => b.type === "text")?.text ?? "");
    const cleaned = cleanForTitle(raw);
    if (cleaned) return truncate(cleaned, MAX_TITLE_LEN);
  }

  if (session.cwd) {
    return basename(session.cwd);
  }

  return "Imported Chat";
}

export function cleanForTitle(text) {
  if (!text) return "";
  let t = text;
  t = t.replace(/<[^>]+>/g, " ");
  t = t.replace(/<user_info>[\s\S]*?<\/user_info>/g, "");
  t = t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "");
  t = t.replace(/<environment_context>[\s\S]*?<\/environment_context>/g, "");
  t = t.replace(/<git_status>[\s\S]*?<\/git_status>/g, "");
  t = t.replace(/<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>/g, "");
  t = t.replace(/<permissions[^>]*>[\s\S]*?<\/permissions>/g, "");
  t = t.replace(/<collaboration_mode>[\s\S]*?<\/collaboration_mode>/g, "");
  t = t.replace(/<apps_instructions>[\s\S]*?<\/apps_instructions>/g, "");
  t = t.replace(/<skills_instructions>[\s\S]*?<\/skills_instructions>/g, "");
  t = t.replace(/<user_query>/g, "");
  t = t.replace(/<\/user_query>/g, "");
  t = t.replace(/```[\s\S]*?```/g, " ");
  t = t.replace(/`[^`]+`/g, " ");
  t = t.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  t = t.replace(/@\S+/g, " ");
  t = t.replace(/^AGENTS\.md\s+instructions\s+for\s+\S+\s*:?\s*/i, "");
  t = t.replace(/[ \t]+/g, " ");
  t = t.replace(/\n+/g, " ");
  t = t.replace(/^#+\s*/, "");
  t = t.trim();
  return t;
}

export function truncate(s, n) {
  if (!s) return "";
  if (s.length <= n) return s;
  return s.slice(0, n - 1).trimEnd() + "…";
}

export function basename(p) {
  if (!p) return "";
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] || p;
}

export function projectDisplay(cwd) {
  if (!cwd) return "";
  return basename(cwd);
}

export function pathShort(p, maxLen = 50) {
  if (!p) return "";
  if (p.length <= maxLen) return p;
  const b = basename(p);
  return `…/${b}`;
}
