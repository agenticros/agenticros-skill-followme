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
    }),

    async execute(_toolCallId, params) {
      const action = (params["action"] as string) ?? "status";

      if (action === "start") {
        startFollowLoop(config, context);
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
