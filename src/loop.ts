/**
 * Follow Me control loop: depth (and optional Ollama) + cmd_vel.
 */

import type { AgenticROSConfig } from "@agenticros/core";
import { toNamespacedTopicFull, applyCmdVelTwistSignConvention } from "@agenticros/core";
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
/** Throttle "tick skipped" warnings when the async body runs longer than the interval. */
let lastTickSkippedLogMs = 0;
let loggedNoDepth = false;
/** Throttle warnings when depthTopic is set but samples stay invalid (bridge/topic/encoding). */
let lastDepthInvalidWarnMs = 0;
let searchTickCount = 0;
let searchDirection = 1; // 1 = turn left (positive angularZ), -1 = turn right
/** Per-session standoff from `follow_robot` tool; cleared on stop. */
let sessionTargetDistanceM: number | null = null;

export function getFollowMeCmdVelTopic(config: AgenticROSConfig): string {
  const fm = getFollowMeConfig(config.skills?.followme);
  const override = (fm.cmdVelTopic ?? "").trim();
  // Teleop often stores a canonical short topic (e.g. `/cmd_vel`); ROS on the robot is usually
  // `/<robot.namespace>/cmd_vel`. Always run through toNamespacedTopicFull so publishes match the bridge.
  if (override) return toNamespacedTopicFull(config, override);
  const teleop = (config.teleop as { cmdVelTopic?: string } | undefined)?.cmdVelTopic?.trim();
  if (teleop) return toNamespacedTopicFull(config, teleop);
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

/**
 * The reported distance uses a lower percentile; when the center ROI mixes a near person with far
 * wall/floor, the percentile can stay "too far" and the robot keeps driving. If the closest pixels
 * disagree strongly with that reading, trust the minimum (guarded for speckle).
 */
function effectiveFollowDistanceM(result: {
  valid: boolean;
  distance_m: number;
  min_m: number;
}): number {
  if (!result.valid || !Number.isFinite(result.distance_m)) return result.distance_m;
  const p = result.distance_m;
  const m = result.min_m;
  if (!Number.isFinite(m) || m <= 0.12) return p;
  if (m < p - 0.06) return Math.min(p, m);
  return p;
}

function runLoopTick(
  transport: RosTransport,
  topic: string,
  config: FollowMeConfig,
  context: SkillContext,
  agentConfig: AgenticROSConfig,
): void {
  if (tickInProgress) {
    const now = Date.now();
    if (now - lastTickSkippedLogMs > 5000) {
      lastTickSkippedLogMs = now;
      context.logger.warn(
        "Follow Me: control tick skipped because the previous tick is still running. " +
          "The robot keeps the last cmd_vel until the next completed tick — if you use Ollama vision, try a lower rateHz or depth-only mode. " +
          "Distance is sampled from the depth topic each tick (not the teleop HTTP video); ensure skills.followme.depthTopic is correct.",
      );
    }
    return;
  }
  tickInProgress = true;
  const targetDistance =
    sessionTargetDistanceM ??
    (typeof config.targetDistance === "number" && config.targetDistance > 0 ? config.targetDistance : 1.0);
  const safety = agentConfig.safety ?? { maxLinearVelocity: 1.0, maxAngularVelocity: 1.5 };
  const vf =
    typeof config.maxVelocityFraction === "number" && config.maxVelocityFraction > 0
      ? config.maxVelocityFraction
      : 0.2;
  const maxLinCap = safety.maxLinearVelocity * vf;
  const maxAngCap = safety.maxAngularVelocity * vf;
  const minLinRaw = config.minLinearVelocity ?? 0.3;
  const minLin = Math.min(minLinRaw, maxLinCap);
  let linearX = 0;
  let angularZ = 0;

  void (async () => {
    const t0 = performance.now();
    let depthMs = 0;
    let sectorsMs = 0;
    let ollamaMs = 0;
    function twistMessage(linX: number, angZ: number) {
      let lx = linX;
      if (config.invertLinearX) lx = -lx;
      lx = Math.max(-maxLinCap, Math.min(maxLinCap, lx));
      const az = Math.max(-maxAngCap, Math.min(maxAngCap, angZ));
      return applyCmdVelTwistSignConvention(topic, TWIST_TYPE, {
        linear: { x: lx, y: 0, z: 0 },
        angular: { x: 0, y: 0, z: az },
      });
    }
    try {
      const depthTopic = (config.depthTopic ?? "").trim();
      const searchAngular = Math.min(config.searchAngularVelocity ?? 0.4, maxAngCap);
      const searchTicksBeforeSwitch = config.searchTicksBeforeSwitch ?? 15;
      const criticalM =
        typeof config.criticalStopDistanceM === "number" && config.criticalStopDistanceM > 0
          ? config.criticalStopDistanceM
          : 0.4;
      let personInView = false;
      let d = NaN;
      let inStandoff = false;
      /** Depth topic configured but sample invalid — do not spin search (reads as "lost"). */
      let depthSampleBad = false;

      if (depthTopic) {
        const d0 = performance.now();
        const result = await context.getDepthDistance(transport, depthTopic, 2000);
        depthMs = performance.now() - d0;
        if (result.valid) {
          personInView = true;
          searchTickCount = 0; // reset search when we see someone
          const dFused = effectiveFollowDistanceM(result);
          // Closest surface in the center ROI (min_m) must participate in range control: when the
          // 12th-percentile and min differ by < 0.06 m, effectiveFollowDistanceM keeps the percentile,
          // which can sit just above criticalStopDistanceM and the base never stops. Always use the
          // conservative (closer) reading when min is not speckle (same 0.12 m floor as depth.ts).
          const minTrustM = 0.12;
          d =
            Number.isFinite(result.min_m) && result.min_m > minTrustM
              ? Math.min(dFused, result.min_m)
              : dFused;
          const deadband = Math.max(0.18, targetDistance * 0.16);
          const tooCloseHard = d <= criticalM;
          inStandoff = !tooCloseHard && Math.abs(d - targetDistance) <= deadband;
          if (tooCloseHard) {
            linearX = 0;
          } else if (inStandoff) {
            linearX = 0;
          } else if (d < targetDistance - deadband) {
            linearX = -minLin;
          } else {
            linearX = minLin;
          }
        } else {
          depthSampleBad = true;
          linearX = 0;
          const now = Date.now();
          if (now - lastDepthInvalidWarnMs > 8000) {
            lastDepthInvalidWarnMs = now;
            context.logger.warn(
              `Follow Me: depth sample invalid on "${depthTopic}" (timeout or no usable pixels). ` +
                "Linear and search motion stay at 0 until depth works. Check: topic name vs `ros2 topic list`, " +
                "sensor_msgs/Image depth is publishing, robot namespace matches config, Zenoh/ROS bridge from robot to gateway.",
            );
          }
        }
      } else {
        if (!loggedNoDepth) {
          context.logger.warn(
            "Follow Me: depthTopic is not set in config.skills.followme; linear velocity will always be 0. Set depthTopic to your depth image topic (e.g. /camera/camera/depth/image_rect_raw) for distance-based following.",
          );
          loggedNoDepth = true;
        }
      }

      const holdHeading = personInView && (inStandoff || d <= criticalM);

      /**
       * Distance (stop / forward / back) comes from the depth image topic: each tick calls
       * getDepthDistance → subscribe, one sensor_msgs/Image, unsubscribe. That is independent of
       * the teleop web video stream. Optional camera/Ollama uses the same pattern on cameraTopic.
       *
       * Ollama and sector steering can take longer than one interval; publish linear.x from depth
       * immediately with angular.z=0 so the base does not keep driving on a stale forward command
       * while waiting for vision.
       */
      const needsSteeringRefinement =
        !holdHeading &&
        personInView &&
        ((config.useOllama && !!config.cameraTopic) ||
          (!!depthTopic && config.useDepthSectors !== false && !config.useOllama));

      if (needsSteeringRefinement) {
        transport.publish({ topic, type: TWIST_TYPE, msg: twistMessage(linearX, 0) });
      }

      // Turn left/right: Ollama (VLM) or depth sectors — not while in standoff / critical (would keep base moving)
      if (!holdHeading && !depthSampleBad) {
        if (config.useOllama && config.cameraTopic) {
          const messageType =
            config.cameraMessageType === "Image" ? IMAGE_TYPE : COMPRESSED_IMAGE_TYPE;
          const o0 = performance.now();
          const position = await getPositionFromOllama(
            transport,
            config.cameraTopic,
            messageType,
            config.ollamaUrl ?? "http://localhost:11434",
            config.vlmModel ?? "qwen3-vl:2b",
          );
          ollamaMs = performance.now() - o0;
          const turnOllama = Math.min(0.4, maxAngCap);
          if (position === "left") angularZ = turnOllama;
          else if (position === "right") angularZ = -turnOllama;
        } else if (personInView && depthTopic && config.useDepthSectors !== false) {
          // Depth-based turning: turn toward the sector (left/center/right) with closest distance
          try {
            const s0 = performance.now();
            const sectors = await context.getDepthSectors(transport, depthTopic, 1500);
            sectorsMs = performance.now() - s0;
            if (sectors.valid) {
              const turnVel = Math.min(0.35, maxAngCap);
              const left = Number.isFinite(sectors.left_m) && sectors.left_m > 0 ? sectors.left_m : Infinity;
              const center = Number.isFinite(sectors.center_m) && sectors.center_m > 0 ? sectors.center_m : Infinity;
              const right = Number.isFinite(sectors.right_m) && sectors.right_m > 0 ? sectors.right_m : Infinity;
              const minD = Math.min(left, center, right);
              if (minD !== Infinity) {
                const centerOk = Math.abs(center - minD) < 0.15;
                if (!centerOk && left === minD) angularZ = turnVel;
                else if (!centerOk && right === minD) angularZ = -turnVel;
              }
            }
          } catch {
            // Sectors failed; keep angularZ 0
          }
        }
      }

      // When person not in view: rotate in place to search, alternating direction
      if (!personInView && depthTopic && !depthSampleBad) {
        searchTickCount++;
        if (searchTickCount >= searchTicksBeforeSwitch) {
          searchDirection = -searchDirection;
          searchTickCount = 0;
        }
        angularZ = searchDirection * searchAngular;
      }

      transport.publish({ topic, type: TWIST_TYPE, msg: twistMessage(linearX, angularZ) });
      if (config.logTickTiming) {
        const totalMs = performance.now() - t0;
        context.logger.info(
          `Follow Me tick timing: total_ms=${totalMs.toFixed(1)} depth_ms=${depthMs.toFixed(1)} sectors_ms=${sectorsMs.toFixed(1)} ollama_ms=${ollamaMs.toFixed(1)} caps lin=${maxLinCap.toFixed(3)} ang=${maxAngCap.toFixed(3)}`,
        );
      }
    } catch (err) {
      const now = Date.now();
      if (now - lastDepthInvalidWarnMs > 8000) {
        lastDepthInvalidWarnMs = now;
        const msg = err instanceof Error ? err.message : String(err);
        context.logger.warn(`Follow Me: tick error (${msg.slice(0, 200)}); publishing zero cmd_vel.`);
      }
      transport.publish({
        topic,
        type: TWIST_TYPE,
        msg: applyCmdVelTwistSignConvention(topic, TWIST_TYPE, { ...ZERO_TWIST }),
      });
    } finally {
      tickInProgress = false;
    }
  })();
}

export function startFollowLoop(
  config: AgenticROSConfig,
  context: SkillContext,
  options?: { targetDistanceM?: number },
): void {
  if (loopInterval) return;
  const td = options?.targetDistanceM;
  sessionTargetDistanceM =
    typeof td === "number" && Number.isFinite(td) ? Math.max(0.25, Math.min(5.0, td)) : null;
  const fm = getFollowMeConfig(config.skills?.followme);
  const rateHz = Math.min(15, Math.max(1, fm.rateHz ?? 5));
  const topic = getFollowMeCmdVelTopic(config);
  const depthTopic = (fm.depthTopic ?? "").trim();
  context.logger.info(
    `Follow Me: loop started → cmd_vel="${topic}", depthTopic="${depthTopic || "(not set)"}", ${rateHz} Hz`,
  );
  loopAbort = new AbortController();

  const transport = context.getTransport();
  loopInterval = setInterval(() => {
    if (loopAbort?.signal.aborted) return;
    runLoopTick(transport, topic, fm, context, config);
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
  lastDepthInvalidWarnMs = 0;
  searchTickCount = 0;
  searchDirection = 1;
  sessionTargetDistanceM = null;

  // Publish zero twist so the robot actually stops (many robots hold last command until a new one)
  try {
    const transport = context.getTransport();
    const topic = getFollowMeCmdVelTopic(config);
    const zero = applyCmdVelTwistSignConvention(topic, TWIST_TYPE, { ...ZERO_TWIST });
    for (let i = 0; i < 3; i++) {
      transport.publish({ topic, type: TWIST_TYPE, msg: zero });
    }
  } catch {
    // Transport may be disconnected; stopping the loop is still done
  }
}

export function isFollowLoopRunning(): boolean {
  return loopInterval != null;
}
