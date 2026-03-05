/**
 * Follow Me control loop: depth (and optional Ollama) + cmd_vel.
 */

import type { AgenticROSConfig } from "@agenticros/core";
import { toNamespacedTopicFull } from "@agenticros/core";
import type { RosTransport } from "@agenticros/core";
import type { SkillContext } from "./types.js";
import type { FollowMeConfig } from "./config.js";
import { getFollowMeConfig } from "./config.js";

const TWIST_TYPE = "geometry_msgs/msg/Twist";
const IMAGE_TYPE = "sensor_msgs/msg/Image";
const COMPRESSED_IMAGE_TYPE = "sensor_msgs/msg/CompressedImage";
const VLM_PROMPT =
  "Describe in one short sentence: Is a person visible in the center of the image? If yes, are they left of center, right of center, or centered? How far do they appear: very close, medium, or far?";

let loopInterval: ReturnType<typeof setInterval> | null = null;
let loopAbort: AbortController | null = null;
let tickInProgress = false;
let loggedNoDepth = false;

export function getFollowMeCmdVelTopic(config: AgenticROSConfig): string {
  const fm = getFollowMeConfig(config.skills?.followme);
  const override = (fm.cmdVelTopic ?? "").trim();
  if (override) return override;
  const teleop = (config.teleop as { cmdVelTopic?: string } | undefined)?.cmdVelTopic?.trim();
  if (teleop) return teleop;
  return toNamespacedTopicFull(config, "/cmd_vel");
}

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

function parsePositionFromVlm(response: string): "left" | "center" | "right" | null {
  const lower = response.toLowerCase();
  if (lower.includes("left")) return "left";
  if (lower.includes("right")) return "right";
  if (lower.includes("center") || lower.includes("centred")) return "center";
  return null;
}

async function getPositionFromOllama(
  transport: RosTransport,
  topic: string,
  messageType: string,
  ollamaUrl: string,
  model: string,
): Promise<"left" | "center" | "right" | null> {
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
    }, 5000);
  });

  const data = msg.data;
  let base64: string;
  if (typeof data === "string") base64 = data;
  else if (Array.isArray(data)) base64 = Buffer.from(data as number[]).toString("base64");
  else if (data != null && typeof (data as { toString: (s: string) => string }).toString === "function")
    base64 = (data as Buffer).toString("base64");
  else throw new Error("No image data");

  const responseText = await callOllamaVision(ollamaUrl, model, base64, VLM_PROMPT);
  return parsePositionFromVlm(responseText);
}

function runLoopTick(
  transport: RosTransport,
  topic: string,
  config: FollowMeConfig,
  context: SkillContext,
): void {
  if (tickInProgress) return;
  tickInProgress = true;
  const targetDistance = config.targetDistance ?? 0.5;
  const minLin = config.minLinearVelocity ?? 0.3;
  let linearX = 0;
  let angularZ = 0;

  void (async () => {
    try {
      const depthTopic = (config.depthTopic ?? "").trim();
      if (depthTopic) {
        const result = await context.getDepthDistance(transport, depthTopic, 2000);
        if (result.valid) {
          const d = result.distance_m;
          if (d < targetDistance * 0.8) linearX = -minLin;
          else if (d > targetDistance * 1.2) linearX = minLin;
        }
      } else {
        if (!loggedNoDepth) {
          context.logger.warn(
            "Follow Me: depthTopic is not set in config.skills.followme; linear velocity will always be 0. Set depthTopic to your depth image topic (e.g. /camera/camera/depth/image_rect_raw) for distance-based following.",
          );
          loggedNoDepth = true;
        }
      }

      if (config.useOllama && config.cameraTopic) {
        const messageType =
          config.cameraMessageType === "Image" ? IMAGE_TYPE : COMPRESSED_IMAGE_TYPE;
        const position = await getPositionFromOllama(
          transport,
          config.cameraTopic,
          messageType,
          config.ollamaUrl ?? "http://localhost:11434",
          config.vlmModel ?? "qwen3-vl:2b",
        );
        if (position === "left") angularZ = 0.4;
        else if (position === "right") angularZ = -0.4;
      }

      const twist = {
        linear: { x: linearX, y: 0, z: 0 },
        angular: { x: 0, y: 0, z: angularZ },
      };
      transport.publish({ topic, type: TWIST_TYPE, msg: twist });
    } catch {
      // Publish zero on error to avoid runaway
      transport.publish({ topic, type: TWIST_TYPE, msg: ZERO_TWIST });
    } finally {
      tickInProgress = false;
    }
  })();
}

export function startFollowLoop(
  config: AgenticROSConfig,
  context: SkillContext,
): void {
  if (loopInterval) return;
  const fm = getFollowMeConfig(config.skills?.followme);
  const rateHz = Math.min(15, Math.max(1, fm.rateHz ?? 5));
  const topic = getFollowMeCmdVelTopic(config);
  loopAbort = new AbortController();

  const transport = context.getTransport();
  loopInterval = setInterval(() => {
    if (loopAbort?.signal.aborted) return;
    runLoopTick(transport, topic, fm, context);
  }, 1000 / rateHz);
}

const ZERO_TWIST = {
  linear: { x: 0, y: 0, z: 0 },
  angular: { x: 0, y: 0, z: 0 },
};

export function stopFollowLoop(
  config: AgenticROSConfig,
  context: SkillContext,
): void {
  if (loopInterval) {
    clearInterval(loopInterval);
    loopInterval = null;
  }
  if (loopAbort) {
    loopAbort.abort();
    loopAbort = null;
  }
  loggedNoDepth = false;

  // Publish zero twist so the robot actually stops (many robots hold last command until a new one)
  try {
    const transport = context.getTransport();
    const topic = getFollowMeCmdVelTopic(config);
    for (let i = 0; i < 3; i++) {
      transport.publish({ topic, type: TWIST_TYPE, msg: ZERO_TWIST });
    }
  } catch {
    // Transport may be disconnected; stopping the loop is still done
  }
}

export function isFollowLoopRunning(): boolean {
  return loopInterval != null;
}
