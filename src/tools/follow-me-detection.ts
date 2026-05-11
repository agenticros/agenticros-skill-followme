/**
 * follow_me_see: Report what the Follow Me tracker sees (when useOllama is on).
 */

import { Type } from "@sinclair/typebox";
import type { AgenticROSConfig } from "@agenticros/core";
import type { SkillPluginApi, SkillContext } from "../types.js";
import { getFollowMeConfig } from "../config.js";
import {
  COMPRESSED_IMAGE_TYPE,
  IMAGE_TYPE,
  HUMAN_DETECTION_PROMPT,
  grabCameraSnapshot,
  callOllamaVision,
  callOpenAIVision,
  parseHumanDetectionResponse,
} from "../vision.js";

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
      "When Follow Me vision is enabled (useOllama, default true), returns the VLM human gate result and lateral hint for the current camera frame. Use when the user asks what the tracker sees or why the robot is not following.",

    parameters: Type.Object({
      timeout: Type.Optional(Type.Number({ description: "Timeout in ms (default 15000)" })),
    }),

    async execute(_toolCallId, params) {
      if (fm.useOllama === false) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Follow Me vision is disabled (skills.followme.useOllama is false). Enable it to use this tool.",
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
      const snapTimeout = Math.min(timeout, fm.cameraSnapshotTimeoutMs ?? 8000);
      const vlmTimeout = timeout;

      try {
        const snapshot = await grabCameraSnapshot(transport, topic, messageType, snapTimeout);

        let responseText: string;
        if (fm.visionProvider === "openai") {
          const apiKey = (fm.openaiApiKey || process.env.OPENAI_API_KEY || "").trim();
          if (!apiKey) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "OpenAI vision selected but no API key. Set skills.followme.openaiApiKey or OPENAI_API_KEY.",
                },
              ],
              details: { error: "no_api_key" },
            };
          }
          const model = fm.openaiVisionModel ?? "gpt-4o-mini";
          const baseUrl = (fm.openaiBaseUrl ?? "").trim() || undefined;
          responseText = await callOpenAIVision(
            apiKey,
            model,
            snapshot,
            HUMAN_DETECTION_PROMPT,
            vlmTimeout,
            baseUrl,
          );
        } else {
          const ollamaUrl = fm.ollamaUrl ?? "http://localhost:11434";
          const model = fm.vlmModel ?? "qwen3-vl:2b";
          responseText = await callOllamaVision(ollamaUrl, model, snapshot.base64, HUMAN_DETECTION_PROMPT, vlmTimeout);
        }

        const parsed = parseHumanDetectionResponse(responseText);

        return {
          content: [
            {
              type: "text" as const,
              text: `VLM: ${responseText}\n\nParsed: human=${parsed.human}, position=${parsed.position ?? "unknown"}`,
            },
          ],
          details: { response: responseText, ...parsed },
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
