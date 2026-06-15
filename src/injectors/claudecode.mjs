import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

function safeId() {
  return randomUUID();
}

function ts(ms) {
  return new Date(ms || Date.now()).toISOString();
}

export async function writeClaudeCode(session, outFile) {
  if (!outFile) throw new Error("writeClaudeCode requires an explicit --out path (writing to live ~/.claude/projects/ is not safe)");
  await fs.mkdir(path.dirname(outFile), { recursive: true });
  const sessionId = session.sessionId || safeId();
  const lines = [];
  let parentUuid = null;

  lines.push(
    JSON.stringify({
      type: "permission-mode",
      permissionMode: session.metadata?.claudecode?.permissionMode || "default",
      sessionId,
    }),
  );

  if (session.title) {
    lines.push(
      JSON.stringify({
        type: "custom-title",
        customTitle: session.title,
        sessionId,
      }),
    );
    lines.push(
      JSON.stringify({
        type: "agent-name",
        agentName: session.title,
        sessionId,
      }),
    );
  }

  for (const m of session.messages) {
    const uuid = safeId();
    if (m.role === "user") {
      const textBlocks = m.blocks.filter((b) => b.type === "text");
      const toolResultBlocks = m.blocks.filter((b) => b.type === "tool_result");
      let content;
      if (toolResultBlocks.length > 0) {
        const arr = [];
        const joinedText = textBlocks.map((b) => b.text).join("\n");
        if (joinedText) arr.push({ type: "text", text: joinedText });
        for (const b of toolResultBlocks) {
          arr.push({
            type: "tool_result",
            tool_use_id: b.toolCallId,
            content: b.text || "",
            is_error: false,
          });
        }
        content = arr;
      } else {
        content = textBlocks.map((b) => b.text).join("\n") || m.text || "";
      }
      lines.push(
        JSON.stringify({
          parentUuid,
          isSidechain: false,
          type: "user",
          message: { role: "user", content },
          isMeta: false,
          uuid,
          timestamp: ts(m.timestamp),
          sessionId,
          cwd: session.cwd || undefined,
        }),
      );
    } else if (m.role === "assistant") {
      const text = (m.blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n")) || m.text || "";
      const content = [];
      if (text) content.push({ type: "text", text });
      for (const b of m.blocks) {
        if (b.type === "reasoning" && b.text) content.push({ type: "thinking", thinking: b.text });
        else if (b.type === "tool_call") {
          content.push({
            type: "tool_use",
            id: b.callId || `toolu_${safeId()}`,
            name: b.tool || "tool",
            input: b.args || {},
          });
        }
      }
      if (content.length === 0) continue;
      const usage = m.metadata?.usage && typeof m.metadata.usage === "object" ? m.metadata.usage : undefined;
      const message = {
        id: safeId(),
        type: "message",
        role: "assistant",
        model: m.modelId || session.model || "claude",
        content,
        stop_reason: m.metadata?.stopReason || "end_turn",
        stop_sequence: null,
      };
      if (usage) message.usage = usage;
      lines.push(
        JSON.stringify({
          parentUuid,
          isSidechain: false,
          message,
          requestId: m.metadata?.requestId || safeId(),
          type: "assistant",
          uuid,
          timestamp: ts(m.timestamp),
          sessionId,
          cwd: session.cwd || undefined,
        }),
      );
    } else if (m.role === "system" || m.role === "developer") {
      const text = m.text || (m.blocks.find((b) => b.type === "text")?.text ?? "");
      lines.push(
        JSON.stringify({
          parentUuid,
          isSidechain: false,
          type: "user",
          isMeta: true,
          message: { role: "user", content: text },
          uuid,
          timestamp: ts(m.timestamp),
          sessionId,
        }),
      );
    } else if (m.role === "tool") {
      const tr = m.blocks.find((b) => b.type === "tool_result");
      const toolUseId = m.toolCallId || tr?.toolCallId || `toolu_${safeId()}`;
      const resultText = m.text || tr?.text || "";
      lines.push(
        JSON.stringify({
          parentUuid,
          isSidechain: false,
          type: "user",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: toolUseId, content: resultText, is_error: false }],
          },
          isMeta: false,
          uuid,
          timestamp: ts(m.timestamp),
          sessionId,
        }),
      );
    }
    parentUuid = uuid;
  }

  await fs.writeFile(outFile, lines.join("\n") + (lines.length ? "\n" : ""));
  return outFile;
}
