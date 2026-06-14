export function toClaudeMarkdown(session, opts = {}) {
  const { includeToolCalls = true, includeReasoning = true } = opts;
  const lines = [];
  const title = session.title || session.sessionId || "Imported Chat";
  lines.push(`# ${title}`);
  lines.push("");

  for (const m of session.messages) {
    const role = m.role === "developer" ? "system" : m.role;
    if (m.role === "system" && m.text.length > 2000) {
      lines.push(`<system>`);
      lines.push(m.text.slice(0, 2000) + (m.text.length > 2000 ? "\n... (truncated)" : ""));
      lines.push(`</system>`);
      lines.push("");
      continue;
    }
    if (m.role === "tool" && !includeToolCalls) continue;

    let content = "";
    if (role === "user") {
      content = m.text || "";
    } else if (role === "assistant") {
      for (const b of m.blocks) {
        if (b.type === "text" && b.text) {
          content += b.text + "\n";
        } else if (b.type === "reasoning" && includeReasoning && b.text) {
          content += b.text + "\n";
        } else if (b.type === "tool_call" && includeToolCalls) {
          content += `<tool_use name="${escAttr(b.tool)}" call_id="${escAttr(b.callId || "")}">\n${safeJson(b.args)}\n</tool_use>\n`;
        }
      }
    } else if (role === "tool") {
      const r = m.blocks.find((b) => b.type === "tool_result");
      const toolCallId = m.toolCallId || r?.toolCallId || "";
      const out = m.text || r?.text || "";
      content = `<tool_result call_id="${escAttr(toolCallId)}">\n${out}\n</tool_result>`;
    } else {
      content = m.text || "";
    }

    lines.push(`<${role}>`);
    lines.push(content.trim());
    lines.push(`</${role}>`);
    lines.push("");
  }

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

function escAttr(s) {
  return String(s || "").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
function safeJson(v) {
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}
