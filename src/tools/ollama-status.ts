/**
 * ollama_status: Check if Ollama is reachable and list models (for Follow Me VLM).
 */

import { Type } from "@sinclair/typebox";
import type { AgenticROSConfig } from "@agenticros/core";
import type { SkillPluginApi } from "../types.js";
import { getFollowMeConfig } from "../config.js";

export function registerOllamaStatusTool(
  api: SkillPluginApi,
  config: AgenticROSConfig,
): void {
  api.registerTool({
    name: "ollama_status",
    label: "Ollama status",
    description:
      "Check if Ollama is reachable and list available models. Use when the user asks if Ollama is running or which vision models are available for Follow Me.",

    parameters: Type.Object({
      ollamaUrl: Type.Optional(
        Type.String({
          description:
            "Ollama API base URL. Default: from plugin config (skills.followme.ollamaUrl) or http://localhost:11434.",
        }),
      ),
    }),

    async execute(_toolCallId, params) {
      const fm = getFollowMeConfig(config.skills?.followme);
      const base =
        (params["ollamaUrl"] as string | undefined)?.trim() ||
        (fm.ollamaUrl ?? "http://localhost:11434").replace(/\/$/, "");

      try {
        const res = await fetch(`${base}/api/tags`, { method: "GET" });
        if (!res.ok) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Ollama at ${base} returned ${res.status}. Is Ollama running? Start with: ollama serve`,
              },
            ],
            details: { reachable: false, status: res.status },
          };
        }

        const data = (await res.json()) as { models?: { name: string }[] };
        const models = data.models ?? [];
        const vlmModel = fm.vlmModel ?? "qwen3-vl:2b";
        const hasVlm = models.some((m) => m.name === vlmModel || m.name.startsWith(vlmModel.split(":")[0]));

        let text = `Ollama at ${base} is reachable. Models: ${models.map((m) => m.name).join(", ") || "none"}.`;
        if (!hasVlm && models.length > 0) {
          const suggest = models[0]?.name ?? vlmModel;
          text += ` Follow Me is configured for "${vlmModel}". To use what you have: set skills.followme.vlmModel to "${suggest}" and restart.`;
        } else if (models.length === 0) {
          text += ` No models listed. Pull a vision model: ollama run ${vlmModel}.`;
        }

        return {
          content: [{ type: "text" as const, text }],
          details: { reachable: true, models: models.map((m) => m.name), vlmModel },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text" as const,
              text: `Ollama at ${base} is not reachable: ${message}. Start Ollama with: ollama serve`,
            },
          ],
          details: { reachable: false, error: message },
        };
      }
    },
  });
}
