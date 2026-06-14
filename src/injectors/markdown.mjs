export function toMarkdown(session, opts = {}) {
  const { includeToolCalls = true, includeReasoning = false, title: titleOverride = null } = opts;
  const lines = [];
  const title = titleOverride || session.title || session.sessionId || "Imported Chat";
  lines.push(`# ${title}`);
  lines.push("");
  const meta = [];
  if (session.source) meta.push(`**Source:** ${session.source}`);
  if (session.model) meta.push(`**Model:** ${session.model}`);
  if (session.cwd) meta.push(`**CWD:** ${session.cwd}`);
  if (session.createdAt) meta.push(`**Created:** ${formatDate(session.createdAt)}`);
  if (meta.length) {
    lines.push(meta.join(" · "));
    lines.push("");
  }

  let msgIndex = 0;
  for (const m of session.messages) {
    if (m.role === "system" && !includeReasoning && m.blocks.every((b) => b.type === "text" && b.text.length > 1000)) {
      lines.push(`> *System prompt omitted (${m.text.length} chars)*`);
      lines.push("");
      continue;
    }
    const header = roleHeader(m.role);
    lines.push(`## ${header}`);
    lines.push("");

    for (const b of m.blocks) {
      switch (b.type) {
        case "text":
          if (b.text) {
            lines.push(b.text);
            lines.push("");
          }
          break;
        case "reasoning":
          if (includeReasoning && b.text) {
            lines.push(`<details>`);
            lines.push(`<summary>reasoning</summary>`);
            lines.push("");
            lines.push(b.text);
            lines.push("");
            lines.push(`</details>`);
            lines.push("");
          }
          break;
        case "tool_call": {
          if (!includeToolCalls) break;
          const status = b.status ? ` (${b.status})` : "";
          lines.push(`### 🔧 ${b.tool}${status}`);
          lines.push("");
          if (b.args !== undefined && b.args !== null) {
            lines.push("**Input:**");
            lines.push("");
            lines.push("```json");
            lines.push(safeJson(b.args));
            lines.push("```");
            lines.push("");
          }
          if (b.output) {
            const out = String(b.output);
            lines.push("**Output:**");
            lines.push("");
            lines.push("```");
            lines.push(out.length > 4000 ? out.slice(0, 4000) + "\n... (truncated)" : out);
            lines.push("```");
            lines.push("");
          }
          break;
        }
        case "tool_result": {
          if (!includeToolCalls) break;
          const out = b.text || "";
          lines.push(`### 📤 Tool result (${b.toolCallId || ""})`);
          lines.push("");
          lines.push("```");
          lines.push(out.length > 4000 ? out.slice(0, 4000) + "\n... (truncated)" : out);
          lines.push("```");
          lines.push("");
          break;
        }
        case "file": {
          lines.push(`### 📎 ${b.path || "file"}`);
          lines.push("");
          if (b.content) {
            lines.push("```");
            lines.push(String(b.content).slice(0, 2000));
            lines.push("```");
            lines.push("");
          }
          break;
        }
      }
    }
    lines.push("---");
    lines.push("");
    msgIndex++;
  }

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

function roleHeader(role) {
  switch (role) {
    case "user": return "👤 User";
    case "assistant": return "🤖 Assistant";
    case "system": return "⚙️ System";
    case "tool": return "🛠️ Tool";
    case "developer": return "🧑‍💻 Developer";
    default: return `• ${role}`;
  }
}

function safeJson(v) {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function formatDate(ts) {
  if (typeof ts === "number") {
    if (ts > 1e12) return new Date(ts).toISOString();
    return new Date(ts * 1000).toISOString();
  }
  return String(ts);
}
