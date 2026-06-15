import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { emptySession, makeBlock, makeMessage } from "../ucf.mjs";

function safeId() {
  return randomUUID().replace(/-/g, "").slice(0, 26);
}

function timestamp() {
  return Date.now();
}

function serializeArgs(args) {
  if (args === undefined || args === null) return "{}";
  if (typeof args === "string") return args;
  try { return JSON.stringify(args); } catch { return JSON.stringify(String(args)); }
}

export async function writeCodex(session, targetDir) {
  await fs.mkdir(targetDir, { recursive: true });
  const now = new Date();
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const slug = (session.title || "imported")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "imported";
  const tsId = now.toISOString().replace(/[:.]/g, "-");
  const id = safeId();
  const fileName = `rollout-${tsId}-${id}.jsonl`;
  const target = path.join(targetDir, yyyy, mm, dd, fileName);

  await fs.mkdir(path.dirname(target), { recursive: true });

  const sessionId = session.sessionId || id;
  const lines = [];

  lines.push(
    JSON.stringify({
      timestamp: now.toISOString(),
      type: "session_meta",
      payload: {
        id: sessionId,
        timestamp: now.toISOString(),
        cwd: session.cwd || process.cwd(),
        originator: "chatport",
        cli_version: "0.0.0",
        source: "chatport-import",
        model_provider: session.model || "openai",
        base_instructions: { text: "" },
      },
    }),
  );

  for (const m of session.messages) {
    const ts = m.timestamp ? new Date(m.timestamp).toISOString() : now.toISOString();

    if (m.role === "user") {
      const content = (m.blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n")) || m.text || "";
      lines.push(
        JSON.stringify({
          timestamp: ts,
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: content }],
          },
        }),
      );
    } else if (m.role === "assistant") {
      let wroteText = false;
      for (const b of m.blocks) {
        if (b.type === "text" && b.text) {
          lines.push(
            JSON.stringify({
              timestamp: ts,
              type: "response_item",
              payload: {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: b.text }],
                phase: "final_answer",
              },
            }),
          );
          wroteText = true;
        } else if (b.type === "reasoning" && (b.text || b.encrypted)) {
          lines.push(
            JSON.stringify({
              timestamp: ts,
              type: "response_item",
              payload: {
                type: "reasoning",
                summary: b.text ? [{ type: "summary_text", text: b.text }] : [],
                encrypted_content: b.encrypted || null,
              },
            }),
          );
        } else if (b.type === "tool_call") {
          lines.push(
            JSON.stringify({
              timestamp: ts,
              type: "response_item",
              payload: {
                type: "function_call",
                name: b.tool || "tool",
                arguments: serializeArgs(b.args),
                call_id: b.callId || `call_${safeId()}`,
              },
            }),
          );
          if (b.output) {
            lines.push(
              JSON.stringify({
                timestamp: ts,
                type: "response_item",
                payload: {
                  type: "function_call_output",
                  call_id: b.callId || "",
                  output: typeof b.output === "string" ? b.output : JSON.stringify(b.output),
                },
              }),
            );
          }
        }
      }
      if (!wroteText && m.text) {
        lines.push(
          JSON.stringify({
            timestamp: ts,
            type: "response_item",
            payload: {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: m.text }],
              phase: "final_answer",
            },
          }),
        );
      }
    } else if (m.role === "system") {
      const text = m.text || (m.blocks.find((b) => b.type === "text")?.text ?? "");
      lines.push(
        JSON.stringify({
          timestamp: ts,
          type: "event_msg",
          payload: { type: "system_prompt", text, kind: "imported" },
        }),
      );
    } else if (m.role === "tool") {
      const tr = m.blocks.find((b) => b.type === "tool_result");
      lines.push(
        JSON.stringify({
          timestamp: ts,
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: m.toolCallId || tr?.toolCallId || "",
            output: m.text || tr?.text || "",
          },
        }),
      );
    } else if (m.role === "developer") {
      const text = m.text || (m.blocks.find((b) => b.type === "text")?.text ?? "");
      lines.push(
        JSON.stringify({
          timestamp: ts,
          type: "event_msg",
          payload: { type: "developer_message", text },
        }),
      );
    }
  }

  await fs.writeFile(target, lines.join("\n") + "\n");
  return target;
}
