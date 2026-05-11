/**
 * Follow Me control loop: VLM gates human presence; depth (RealSense) sets range; cmd_vel.
 */

import type { AgenticROSConfig } from "@agenticros/core";
import { toNamespacedTopicFull, applyCmdVelTwistSignConvention } from "@agenticros/core";
import type { RosTransport } from "@agenticros/core";
import type { SkillContext } from "./types.js";
import type { FollowMeConfig } from "./config.js";
import { getFollowMeConfig } from "./config.js";
import {
  IMAGE_TYPE,
  COMPRESSED_IMAGE_TYPE,
  HUMAN_DETECTION_PROMPT,
  grabCameraSnapshot,
  callOllamaVision,
  callOpenAIVision,
  parseHumanDetectionResponse,
  type LateralPosition,
} from "./vision.js";

const TWIST_TYPE = "geometry_msgs/msg/Twist";

let loopInterval: ReturnType<typeof setInterval> | null = null;
let loopAbort: AbortController | null = null;
let tickInProgress = false;
let lastTickSkippedLogMs = 0;
let loggedNoDepth = false;
/** Throttle warnings when depthTopic is set but samples stay invalid (bridge/topic/encoding). */
let lastDepthInvalidWarnMs = 0;
let loggedNoCameraForVision = false;
let loggedMissingOpenAiKey = false;
let searchTickCount = 0;
let searchDirection = 1;
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

/**
 * Distance fusion: percentile vs min (see plugin depth helper).
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

/**
 * Single range estimate for control: prefer the closer of percentile vs minimum pixel depth.
 * Previously we ignored min when ≤0.12 m (speckle guard); that let a far wall percentile (~5 m)
 * dominate while the person was actually close — robot never stopped.
 */
function followRangeDistanceM(result: {
  valid: boolean;
  distance_m: number;
  min_m: number;
}): number {
  const p = effectiveFollowDistanceM(result);
  if (!result.valid || !Number.isFinite(p)) return p;
  const minM = result.min_m;
  if (!Number.isFinite(minM) || minM <= 0.02) return p;
  let d = Math.min(p, minM);
  // Depth dropout speckle (<3 cm) with otherwise far scene — ignore lone pixel
  if (minM < 0.03 && p > 4.0) d = p;
  return d;
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
          "Lower skills.followme.rateHz or use a faster VLM; each tick waits for camera + vision + depth.",
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
    let visionMs = 0;
    const snapTimeout = config.cameraSnapshotTimeoutMs ?? 4000;
    const vlmTimeout = config.vlmTimeoutMs ?? 12000;

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

    const depthTopic = (config.depthTopic ?? "").trim();
    const searchAngular = Math.min(config.searchAngularVelocity ?? 0.4, maxAngCap);
    const searchTicksBeforeSwitch = config.searchTicksBeforeSwitch ?? 15;
    const criticalM =
      typeof config.criticalStopDistanceM === "number" && config.criticalStopDistanceM > 0
        ? config.criticalStopDistanceM
        : 0.4;

    const cameraTopic = (config.cameraTopic ?? "").trim();
    const visionEnabled = config.useOllama !== false && !!cameraTopic;

    let humanSeen = false;
    let vlmSaysClose = false;
    let lateralHint: LateralPosition | null = null;
    let visionError = false;
    let depthSampleBad = false;
    let d = NaN;
    let inStandoff = false;

    try {
      /* ---------- Vision: human gate + lateral hint (optional OpenAI or Ollama) ---------- */
      if (visionEnabled) {
        const messageType =
          config.cameraMessageType === "Image" ? IMAGE_TYPE : COMPRESSED_IMAGE_TYPE;
        const v0 = performance.now();
        try {
          const snapshot = await grabCameraSnapshot(transport, cameraTopic, messageType, snapTimeout);
          let rawText: string;
          if (config.visionProvider === "openai") {
            const apiKey = (config.openaiApiKey || process.env.OPENAI_API_KEY || "").trim();
            if (!apiKey) {
              if (!loggedMissingOpenAiKey) {
                loggedMissingOpenAiKey = true;
                context.logger.warn(
                  "Follow Me: visionProvider is openai but no API key. Set skills.followme.openaiApiKey or OPENAI_API_KEY.",
                );
              }
              visionError = true;
            } else {
              const model = config.openaiVisionModel ?? "gpt-4o-mini";
              const baseUrl = (config.openaiBaseUrl ?? "").trim() || undefined;
              rawText = await callOpenAIVision(apiKey, model, snapshot, HUMAN_DETECTION_PROMPT, vlmTimeout, baseUrl);
              const parsed = parseHumanDetectionResponse(rawText);
              humanSeen = parsed.human;
              vlmSaysClose = parsed.appearsClose;
              lateralHint = parsed.position;
            }
          } else {
            const ollamaUrl = config.ollamaUrl ?? "http://localhost:11434";
            const model = config.vlmModel ?? "qwen3-vl:2b";
            rawText = await callOllamaVision(ollamaUrl, model, snapshot.base64, HUMAN_DETECTION_PROMPT, vlmTimeout);
            const parsed = parseHumanDetectionResponse(rawText);
            humanSeen = parsed.human;
            vlmSaysClose = parsed.appearsClose;
            lateralHint = parsed.position;
          }
        } catch (err) {
          visionError = true;
          const msg = err instanceof Error ? err.message : String(err);
          context.logger.warn(`Follow Me vision tick failed: ${msg}`);
        }
        visionMs = performance.now() - v0;
      } else if (config.useOllama !== false && !cameraTopic && !loggedNoCameraForVision) {
        loggedNoCameraForVision = true;
        context.logger.warn(
          "Follow Me: useOllama defaults to true but cameraTopic is empty; falling back to depth-only (no human gate). Set skills.followme.cameraTopic.",
        );
      }

      /**
       * Depth for distance only when:
       * - legacy depth-only mode (vision off), or
       * - vision on and the VLM reports a person (trust RealSense range on the ROI).
       */
      const shouldSampleDepth =
        !!depthTopic && (!visionEnabled || (humanSeen && !visionError));

      if (shouldSampleDepth) {
        const d0 = performance.now();
        const result = await context.getDepthDistance(transport, depthTopic, 2000);
        depthMs = performance.now() - d0;
        if (result.valid) {
          searchTickCount = 0;
          d = followRangeDistanceM(result);
          const deadband = Math.max(0.15, targetDistance * 0.12);
          const tooCloseHard = d <= criticalM;
          inStandoff = !tooCloseHard && Math.abs(d - targetDistance) <= deadband;

          const allowLinear =
            !visionEnabled || (humanSeen && !visionError && Number.isFinite(d));

          if (allowLinear) {
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
            linearX = 0;
          }

          /* VLM sees person as visually close — never trust a far depth percentile over that */
          if (visionEnabled && humanSeen && !visionError && vlmSaysClose) {
            linearX = 0;
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
      } else if (depthTopic && visionEnabled && humanSeen && visionError) {
        linearX = 0;
      } else if (!depthTopic) {
        if (!loggedNoDepth) {
          context.logger.warn(
            "Follow Me: depthTopic is not set; linear velocity stays 0. Set skills.followme.depthTopic (e.g. /camera/camera/depth/image_rect_raw).",
          );
          loggedNoDepth = true;
        }
      }

      let personInView: boolean;
      if (visionEnabled && !visionError) {
        personInView = humanSeen;
      } else if (visionEnabled && visionError) {
        personInView = false;
      } else if (!visionEnabled && depthTopic) {
        personInView = Number.isFinite(d) && !depthSampleBad;
      } else {
        personInView = Number.isFinite(d) && !depthSampleBad;
      }

      const holdHeading = personInView && Number.isFinite(d) && (inStandoff || d <= criticalM);

      /* ---------- Steering ---------- */
      const depthOkForSteering = !depthSampleBad || (visionEnabled && humanSeen && !visionError);
      if (!holdHeading && depthOkForSteering) {
        if (visionEnabled && humanSeen && !visionError && lateralHint != null) {
          const turnVel = Math.min(0.4, maxAngCap);
          if (lateralHint === "left") angularZ = turnVel;
          else if (lateralHint === "right") angularZ = -turnVel;
        } else if (
          !visionEnabled &&
          personInView &&
          depthTopic &&
          config.useDepthSectors !== false
        ) {
          try {
            const s0 = performance.now();
            const sectors = await context.getDepthSectors(transport, depthTopic, 1500);
            sectorsMs = performance.now() - s0;
            if (sectors.valid) {
              const turnVel = Math.min(0.35, maxAngCap);
              const left = Number.isFinite(sectors.left_m) && sectors.left_m > 0 ? sectors.left_m : Infinity;
              const center =
                Number.isFinite(sectors.center_m) && sectors.center_m > 0 ? sectors.center_m : Infinity;
              const right = Number.isFinite(sectors.right_m) && sectors.right_m > 0 ? sectors.right_m : Infinity;
              const minD = Math.min(left, center, right);
              if (minD !== Infinity) {
                const centerOk = Math.abs(center - minD) < 0.15;
                if (!centerOk && left === minD) angularZ = turnVel;
                else if (!centerOk && right === minD) angularZ = -turnVel;
              }
            }
          } catch {
            // keep angularZ 0
          }
        }
      }

      /* Search: no human (vision) or lost depth target (legacy) */
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
          `Follow Me tick: total_ms=${totalMs.toFixed(1)} vision_ms=${visionMs.toFixed(1)} depth_ms=${depthMs.toFixed(1)} sectors_ms=${sectorsMs.toFixed(1)} human=${visionEnabled ? humanSeen : "n/a"} vlm_close=${visionEnabled ? vlmSaysClose : "n/a"} d_m=${Number.isFinite(d) ? d.toFixed(2) : "na"}`,
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
  loggedNoCameraForVision = false;
  loggedMissingOpenAiKey = false;
  searchTickCount = 0;
  searchDirection = 1;
  sessionTargetDistanceM = null;

  try {
    const transport = context.getTransport();
    const topic = getFollowMeCmdVelTopic(config);
    const zero = applyCmdVelTwistSignConvention(topic, TWIST_TYPE, { ...ZERO_TWIST });
    for (let i = 0; i < 3; i++) {
      transport.publish({ topic, type: TWIST_TYPE, msg: zero });
    }
  } catch {
    // Transport may be disconnected
  }
}

export function isFollowLoopRunning(): boolean {
  return loopInterval != null;
}
