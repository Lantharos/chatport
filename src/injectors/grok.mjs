import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

function ts7() {
  return randomUUID();
}

function encodePath(p) {
  return p.replace(/\//g, "%2F");
}

export async function writeGrok(session, targetRoot) {
  const cwd = session.cwd || process.cwd();
  const encoded = encodePath(cwd);
  const sessionId = session.sessionId || ts7();
  const dir = path.join(targetRoot, encoded, sessionId);
  await fs.mkdir(dir, { recursive: true });

  const now = new Date().toISOString();
  const lines = [];

  const firstUser = session.messages.find((m) => m.role === "user");
  const sysText = firstUser
    ? (session.messages.find((m) => m.role === "system")?.text || "You are Grok, a helpful AI assistant.")
    : "You are Grok, a helpful AI assistant.";

  lines.push(JSON.stringify({ type: "system", content: sysText, created_at: now }));

  const consumedToolMessages = new Set();

  for (const m of session.messages) {
    const ts = m.timestamp ? new Date(m.timestamp).toISOString() : now;
    if (m.role === "user") {
      const text = m.text || (m.blocks.find((b) => b.type === "text")?.text ?? "");
      lines.push(JSON.stringify({
        type: "user",
        content: [{ type: "text", text }],
        created_at: ts,
      }));
    } else if (m.role === "assistant") {
      const reasoningBlock = m.blocks.find((b) => b.type === "reasoning");
      const toolCallBlocks = m.blocks.filter((b) => b.type === "tool_call");
      const toolCalls = toolCallBlocks.map((b) => ({
        id: b.callId || `call-${Math.random().toString(36).slice(2)}`,
        name: b.tool,
        arguments: typeof b.args === "string" ? b.args : JSON.stringify(b.args || {}),
      }));
      const content = m.blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n");
      lines.push(JSON.stringify({
        type: "assistant",
        content: content || "",
        reasoning: reasoningBlock
          ? { text: reasoningBlock.text || "", encrypted: reasoningBlock.encrypted || "", id: `rs_${Math.random().toString(36).slice(2)}` }
          : null,
        tool_calls: toolCalls,
        model_id: m.modelId || session.model || "grok-build",
        created_at: ts,
      }));
      for (let i = 0; i < toolCalls.length; i++) {
        const tc = toolCalls[i];
        const sourceBlock = toolCallBlocks[i];
        let output = sourceBlock?.output;
        let consumedKey = null;
        if (output === undefined || output === null) {
          const toolMsgIndex = session.messages.findIndex(
            (mm) => mm.role === "tool" && !consumedToolMessages.has(mm) && (mm.toolCallId === tc.id || mm.blocks.some((b) => b.type === "tool_result" && b.toolCallId === tc.id)),
          );
          if (toolMsgIndex >= 0) {
            consumedKey = toolMsgIndex;
            const toolMsg = session.messages[toolMsgIndex];
            const trBlock = toolMsg.blocks.find((b) => b.type === "tool_result");
            output = toolMsg.text || trBlock?.text || "";
          }
        }
        if (consumedKey !== null) consumedToolMessages.add(consumedKey);
        if (output !== undefined && output !== null) {
          lines.push(JSON.stringify({
            type: "tool_result",
            tool_call_id: tc.id,
            content: typeof output === "string" ? output : JSON.stringify(output),
            created_at: ts,
          }));
        }
      }
    } else if (m.role === "tool") {
      const msgIndex = session.messages.indexOf(m);
      if (consumedToolMessages.has(msgIndex)) continue;
      const tr = m.blocks.find((b) => b.type === "tool_result");
      lines.push(JSON.stringify({
        type: "tool_result",
        tool_call_id: m.toolCallId || tr?.toolCallId || "",
        content: m.text || tr?.text || "",
        created_at: ts,
      }));
    }
  }

  await fs.writeFile(path.join(dir, "chat_history.jsonl"), lines.join("\n") + "\n");

  const summary = {
    info: { id: sessionId, cwd },
    session_summary: "",
    created_at: now,
    updated_at: now,
    num_messages: session.messages.length,
    num_chat_messages: session.messages.filter((m) => m.role === "user" || m.role === "assistant").length,
    current_model_id: session.model || "grok-build",
    next_trace_turn: 0,
    chat_format_version: 1,
    grok_home: targetRoot,
    agent_name: "cursor",
  };
  await fs.writeFile(path.join(dir, "summary.json"), JSON.stringify(summary, null, 2));

  if (session.messages.some((m) => m.role === "system")) {
    const sys = session.messages.find((m) => m.role === "system");
    await fs.writeFile(path.join(dir, "system_prompt.txt"), sys.text || "");
  }

  return dir;
}
