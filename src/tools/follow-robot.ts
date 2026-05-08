import { Type } from "@sinclair/typebox";
import type { AgenticROSConfig } from "@agenticros/core";
import type { SkillPluginApi, SkillContext } from "../types.js";
import { startFollowLoop, stopFollowLoop, isFollowLoopRunning } from "../loop.js";

export function registerFollowRobotTool(
  api: SkillPluginApi,
  config: AgenticROSConfig,
  context: SkillContext,
): void {

  api.registerTool({
    name: "follow_robot",
    label: "Follow robot",
    description:
      "Start or stop the Follow Me behavior. Uses depth (and optionally Ollama) to follow the user. " +
      "Action: start = begin following, stop = halt, status = report whether following is active.",

    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("start"),
        Type.Literal("stop"),
        Type.Literal("status"),
      ], {
        description: "start to begin following, stop to halt, status to check state",
      }),
      target_distance_m: Type.Optional(
        Type.Number({
          minimum: 0.25,
          maximum: 5,
          description:
            "Standoff distance in meters when action is start (e.g. 1). Matches config default if omitted.",
        }),
      ),
    }),

    async execute(_toolCallId, params) {
      const action = (params["action"] as string) ?? "status";

      if (action === "start") {
        const raw = params["target_distance_m"];
        const targetDistanceM =
          typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
        startFollowLoop(
          config,
          context,
          targetDistanceM != null ? { targetDistanceM } : undefined,
        );
        return {
          content: [{ type: "text" as const, text: "Follow Me started. The robot will follow you; say \"stop following\" to halt." }],
          details: { started: true },
        };
      }

      if (action === "stop") {
        stopFollowLoop(config, context);
        return {
          content: [{ type: "text" as const, text: "Follow Me stopped." }],
          details: { stopped: true },
        };
      }

      // status
      const running = isFollowLoopRunning();
      return {
        content: [
          {
            type: "text" as const,
            text: running
              ? "Follow Me is **active**. Use action `stop` to halt."
              : "Follow Me is **not** running. Use action `start` to begin.",
          },
        ],
        details: { running },
      };
    },
  });
}
