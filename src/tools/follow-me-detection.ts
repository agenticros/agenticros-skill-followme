/**
 * follow_me_see: Report what the Follow Me tracker sees (when useOllama is on).
 */

import { Type } from "@sinclair/typebox";
import type { AgenticROSConfig } from "@agenticros/core";
import type { SkillPluginApi, SkillContext } from "../types.js";
import { getFollowMeConfig } from "../config.js";

const COMPRESSED_IMAGE_TYPE = "sensor_msgs/msg/CompressedImage";
const IMAGE_TYPE = "sensor_msgs/msg/Image";
const VLM_PROMPT =
  "Describe in one short sentence: Is a person visible in the center of the image? If yes, are they left of center, right of center, or centered? How far do they appear: very close, medium, or far?";

async function callOllamaVision(
  ollamaUrl: string,
  model: string,
  base64Image: string,
  prompt: string,
  timeoutMs = 15000,
): Promise<string> {
  const url = `${ollamaUrl.replace(/\/$/, "")}/api/generate`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        prompt,
        images: [base64Image],
        stream: false,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`Ollama ${res.status}: ${t.slice(0, 200)}`);
    }
    const data = (await res.json()) as { response?: string };
    return (data.response ?? "").trim();
  } finally {
    clearTimeout(timer);
  }
}

export function registerFollowMeDetectionTool(
  api: SkillPluginApi,
  config: AgenticROSConfig,
  context: SkillContext,
): void {
  const fm = getFollowMeConfig(config.skills?.followme);

  api.registerTool({
    name: "follow_me_see",
    label: "Follow Me see",
    description:
      "When Follow Me is using Ollama (useOllama is true), returns what the vision model sees in the current camera frame (person position and distance hint). Use when the user asks what the tracker sees or why the robot is not following.",

    parameters: Type.Object({
      timeout: Type.Optional(Type.Number({ description: "Timeout in ms (default 15000)" })),
    }),

    async execute(_toolCallId, params) {
      if (!fm.useOllama) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Follow Me is not using Ollama. Set skills.followme.useOllama to true to use this tool.",
            },
          ],
          details: { useOllama: false },
        };
      }

      const transport = context.getTransport();
      const topic = (fm.cameraTopic ?? "").trim() || "/camera/image_raw/compressed";
      const messageType =
        fm.cameraMessageType === "Image" ? IMAGE_TYPE : COMPRESSED_IMAGE_TYPE;
      const timeout = (params["timeout"] as number | undefined) ?? 15000;

      try {
        const msg = await new Promise<Record<string, unknown>>((resolve, reject) => {
          const sub = transport.subscribe(
            { topic, type: messageType },
            (m: Record<string, unknown>) => {
              clearTimeout(timer);
              sub.unsubscribe();
              resolve(m);
            },
          );
          const timer = setTimeout(() => {
            sub.unsubscribe();
            reject(new Error("Camera snapshot timeout"));
          }, Math.min(timeout, 8000));
        });

        const data = msg.data;
        let base64: string;
        if (typeof data === "string") base64 = data;
        else if (Array.isArray(data))
          base64 = Buffer.from(data as number[]).toString("base64");
        else if (
          data != null &&
          typeof (data as { toString: (s: string) => string }).toString === "function"
        )
          base64 = (data as Buffer).toString("base64");
        else throw new Error("No image data");

        const ollamaUrl = fm.ollamaUrl ?? "http://localhost:11434";
        const model = fm.vlmModel ?? "qwen3-vl:2b";
        const responseText = await callOllamaVision(ollamaUrl, model, base64, VLM_PROMPT, timeout);

        return {
          content: [
            {
              type: "text" as const,
              text: `What the tracker sees: ${responseText}`,
            },
          ],
          details: { response: responseText },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text" as const,
              text: `follow_me_see failed: ${message}`,
            },
          ],
          details: { success: false, error: message },
        };
      }
    },
  });
}
