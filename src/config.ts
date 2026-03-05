/**
 * Follow Me skill config slice: config.skills.followme
 */

export interface FollowMeConfig {
  useOllama?: boolean;
  ollamaUrl?: string;
  vlmModel?: string;
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
}

const DEFAULTS: Required<FollowMeConfig> = {
  useOllama: false,
  ollamaUrl: "http://localhost:11434",
  vlmModel: "qwen3-vl:2b",
  cameraTopic: "/camera/image_raw/compressed",
  cameraMessageType: "CompressedImage",
  cmdVelTopic: "",
  targetDistance: 0.5,
  rateHz: 5,
  minLinearVelocity: 0.3,
  depthTopic: "",
  visionCallbackUrl: "",
  useDepthSectors: true,
  searchAngularVelocity: 0.4,
  searchTicksBeforeSwitch: 15,
};

export function getFollowMeConfig(skillsSlice: unknown): FollowMeConfig {
  if (!skillsSlice || typeof skillsSlice !== "object") return DEFAULTS;
  const c = skillsSlice as Record<string, unknown>;
  return {
    useOllama: c.useOllama === true,
    ollamaUrl: typeof c.ollamaUrl === "string" ? c.ollamaUrl : DEFAULTS.ollamaUrl,
    vlmModel: typeof c.vlmModel === "string" ? c.vlmModel : DEFAULTS.vlmModel,
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
  };
}
