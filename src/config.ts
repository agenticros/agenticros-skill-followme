/**
 * Follow Me skill config slice: config.skills.followme
 */

export interface FollowMeConfig {
  /**
   * Use a VLM on the camera to decide if a person is visible before trusting depth for range.
   * Default true. When false, any valid depth sample is treated as "target in view" (legacy).
   */
  useOllama?: boolean;
  /** Vision backend for human detection + lateral position. Default "ollama". */
  visionProvider?: "ollama" | "openai";
  ollamaUrl?: string;
  vlmModel?: string;
  /** API key for OpenAI-compatible vision (also reads env OPENAI_API_KEY if unset). */
  openaiApiKey?: string;
  /** Model id for OpenAI vision (e.g. gpt-4o-mini). */
  openaiVisionModel?: string;
  /** Optional API base (default https://api.openai.com/v1). Use for Azure proxy if needed. */
  openaiBaseUrl?: string;
  cameraTopic?: string;
  cameraMessageType?: "CompressedImage" | "Image";
  cmdVelTopic?: string;
  targetDistance?: number;
  rateHz?: number;
  minLinearVelocity?: number;
  depthTopic?: string;
  visionCallbackUrl?: string;
  /** Use depth sectors (left/center/right) to turn toward person when not using Ollama. Default true. */
  useDepthSectors?: boolean;
  /** Angular speed (rad/s) when searching for person when lost. Default 0.4. */
  searchAngularVelocity?: number;
  /** Number of loop ticks to rotate one direction before switching when searching. Default 15. */
  searchTicksBeforeSwitch?: number;
  /**
   * If fused depth is at or below this distance (m), publish zero linear — hard stop when too close.
   * Default 0.55. Lower only if your depth is noisy near the sensor.
   */
  criticalStopDistanceM?: number;
  /** Negate cmd_vel linear.x before publishing (robot drives backward when UI says forward). Default false. */
  invertLinearX?: boolean;
  /** Log per-tick timing (depth / vision / total) for latency debugging. Default false. */
  logTickTiming?: boolean;
  /** Timeout (ms) for each VLM request (Ollama generate / OpenAI chat). Default 12000. */
  vlmTimeoutMs?: number;
  /** Timeout (ms) to receive one camera message when grabbing a frame. Default 4000. */
  cameraSnapshotTimeoutMs?: number;
  /**
   * Fraction of safety.maxLinearVelocity / maxAngularVelocity used as the cap for Follow Me (e.g. 0.2 = 20%).
   * Default 0.2.
   */
  maxVelocityFraction?: number;
}

const DEFAULTS: Required<FollowMeConfig> = {
  useOllama: true,
  visionProvider: "ollama",
  ollamaUrl: "http://localhost:11434",
  vlmModel: "qwen3-vl:2b",
  openaiApiKey: "",
  openaiVisionModel: "gpt-4o-mini",
  openaiBaseUrl: "",
  cameraTopic: "/camera/camera/image_raw/compressed",
  cameraMessageType: "CompressedImage",
  cmdVelTopic: "",
  /** Meters; person should stop near this range (loop uses a deadband around this value). */
  targetDistance: 1.0,
  rateHz: 5,
  minLinearVelocity: 0.2,
  depthTopic: "/camera/camera/depth/image_rect_raw",
  visionCallbackUrl: "",
  useDepthSectors: true,
  searchAngularVelocity: 0.4,
  searchTicksBeforeSwitch: 15,
  /** Hard zero linear when fused depth ≤ this (m); slightly generous default for indoor RealSense. */
  criticalStopDistanceM: 0.55,
  invertLinearX: false,
  logTickTiming: true,
  maxVelocityFraction: 0.2,
  vlmTimeoutMs: 12000,
  cameraSnapshotTimeoutMs: 4000,
};

export function getFollowMeConfig(skillsSlice: unknown): FollowMeConfig {
  if (!skillsSlice || typeof skillsSlice !== "object") return DEFAULTS;
  const c = skillsSlice as Record<string, unknown>;
  return {
    useOllama: typeof c.useOllama === "boolean" ? c.useOllama : DEFAULTS.useOllama,
    visionProvider: c.visionProvider === "openai" ? "openai" : DEFAULTS.visionProvider,
    ollamaUrl: typeof c.ollamaUrl === "string" ? c.ollamaUrl : DEFAULTS.ollamaUrl,
    vlmModel: typeof c.vlmModel === "string" ? c.vlmModel : DEFAULTS.vlmModel,
    openaiApiKey: typeof c.openaiApiKey === "string" ? c.openaiApiKey : DEFAULTS.openaiApiKey,
    openaiVisionModel:
      typeof c.openaiVisionModel === "string" ? c.openaiVisionModel : DEFAULTS.openaiVisionModel,
    openaiBaseUrl: typeof c.openaiBaseUrl === "string" ? c.openaiBaseUrl : DEFAULTS.openaiBaseUrl,
    cameraTopic: typeof c.cameraTopic === "string" ? c.cameraTopic : DEFAULTS.cameraTopic,
    cameraMessageType:
      c.cameraMessageType === "Image" ? "Image" : DEFAULTS.cameraMessageType,
    cmdVelTopic: typeof c.cmdVelTopic === "string" ? c.cmdVelTopic : DEFAULTS.cmdVelTopic,
    targetDistance: typeof c.targetDistance === "number" ? c.targetDistance : DEFAULTS.targetDistance,
    rateHz: typeof c.rateHz === "number" ? c.rateHz : DEFAULTS.rateHz,
    minLinearVelocity:
      typeof c.minLinearVelocity === "number" ? c.minLinearVelocity : DEFAULTS.minLinearVelocity,
    depthTopic: typeof c.depthTopic === "string" ? c.depthTopic : DEFAULTS.depthTopic,
    visionCallbackUrl:
      typeof c.visionCallbackUrl === "string" ? c.visionCallbackUrl : DEFAULTS.visionCallbackUrl,
    useDepthSectors: c.useDepthSectors !== false,
    searchAngularVelocity:
      typeof c.searchAngularVelocity === "number" ? c.searchAngularVelocity : DEFAULTS.searchAngularVelocity,
    searchTicksBeforeSwitch:
      typeof c.searchTicksBeforeSwitch === "number" ? c.searchTicksBeforeSwitch : DEFAULTS.searchTicksBeforeSwitch,
    criticalStopDistanceM:
      typeof c.criticalStopDistanceM === "number" ? c.criticalStopDistanceM : DEFAULTS.criticalStopDistanceM,
    invertLinearX: c.invertLinearX === true,
    logTickTiming: c.logTickTiming === true,
    maxVelocityFraction:
      typeof c.maxVelocityFraction === "number" && c.maxVelocityFraction > 0
        ? c.maxVelocityFraction
        : DEFAULTS.maxVelocityFraction,
    vlmTimeoutMs: typeof c.vlmTimeoutMs === "number" ? c.vlmTimeoutMs : DEFAULTS.vlmTimeoutMs,
    cameraSnapshotTimeoutMs:
      typeof c.cameraSnapshotTimeoutMs === "number"
        ? c.cameraSnapshotTimeoutMs
        : DEFAULTS.cameraSnapshotTimeoutMs,
  };
}
