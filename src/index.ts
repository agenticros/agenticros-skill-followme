/**
 * AgenticROS Follow Me skill.
 * Registers tools: follow_robot, follow_me_see, ollama_status.
 * Config: config.skills.followme
 */

import type { AgenticROSConfig } from "@agenticros/core";
import type { SkillPluginApi, SkillContext } from "./types.js";
import { registerFollowRobotTool } from "./tools/follow-robot.js";
import { registerFollowMeDetectionTool } from "./tools/follow-me-detection.js";
import { registerOllamaStatusTool } from "./tools/ollama-status.js";

export function registerSkill(
  api: SkillPluginApi,
  config: AgenticROSConfig,
  context: SkillContext,
): void {
  registerFollowRobotTool(api, config, context);
  registerFollowMeDetectionTool(api, config, context);
  registerOllamaStatusTool(api, config);
}
