/**
 * Camera snapshot + VLM human detection (Ollama or OpenAI).
 * Used by Follow Me so motion is gated on a visible person, then depth handles range.
 */

import type { RosTransport } from "@agenticros/core";

const IMAGE_TYPE = "sensor_msgs/msg/Image";
const COMPRESSED_IMAGE_TYPE = "sensor_msgs/msg/CompressedImage";

/** Single-turn prompt: structured answer for reliable parsing. */
export const HUMAN_DETECTION_PROMPT = `You assist a mobile robot with a forward RGB camera.
Answer in EXACTLY four lines using this template (uppercase keywords):

DETECT: YES or NO
POSITION: LEFT or CENTER or RIGHT
CLOSE: YES or NO
NOTE: one short phrase

Rules:
- DETECT YES only if at least one clearly visible person (face or body) is in the image.
- DETECT NO if there is no person, only furniture/walls/floor, or the person is too small/unclear.
- POSITION is where the main person is relative to the image center (left/center/right). If DETECT is NO, still write POSITION: CENTER.
- CLOSE YES if DETECT is YES and the person appears within roughly 1–2 meters or fills a large part of the frame (near enough that the robot must not drive forward). CLOSE NO if the person appears clearly farther away.

Examples:
DETECT: YES
POSITION: LEFT
CLOSE: YES
NOTE: person close on left

DETECT: NO
POSITION: CENTER
CLOSE: NO
NOTE: empty room`;

export type LateralPosition = "left" | "center" | "right";

export interface CameraSnapshot {
  base64: string;
  /** MIME type for OpenAI image URLs (e.g. image/jpeg). */
  mimeType: string;
}

export interface HumanDetectionResult {
  human: boolean;
  position: LateralPosition | null;
  /** VLM says person is visually close — force zero forward even if depth reads far (wrong ROI). */
  appearsClose: boolean;
  rawText: string;
}

export function parseHumanDetectionResponse(text: string): HumanDetectionResult {
  const rawText = text.trim();
  const lower = rawText.toLowerCase();

  let human: boolean | null = null;
  const detectLine = rawText.match(/DETECT:\s*(YES|NO)\b/i);
  if (detectLine) {
    human = detectLine[1].toUpperCase() === "YES";
  }

  if (human === null) {
    if (
      /\b(no person|nobody|no one|not visible|empty (room|scene)|no human)\b/i.test(lower) ||
      /\b(?:there is|there are)\s+no\s+(?:people|person|humans)\b/i.test(lower)
    ) {
      human = false;
    } else if (/\b(person|people|human)\s+(is|are)\s+(visible|present|here)\b/i.test(lower)) {
      human = true;
    }
  }

  let position: LateralPosition | null = null;
  const posLine = rawText.match(/POSITION:\s*(LEFT|CENTER|RIGHT|CENTRE)\b/i);
  if (posLine) {
    const p = posLine[1].toUpperCase();
    if (p === "LEFT") position = "left";
    else if (p === "RIGHT") position = "right";
    else position = "center";
  } else {
    const posFromVlm = parseLateralHint(lower);
    if (posFromVlm) position = posFromVlm;
  }

  if (human === null) human = false;

  let appearsClose = false;
  const closeLine = rawText.match(/CLOSE:\s*(YES|NO)\b/i);
  if (closeLine) {
    appearsClose = closeLine[1].toUpperCase() === "YES";
  } else if (human) {
    if (
      /\b(very close|right in front|near the camera|fills (much |most )?of the frame)\b/i.test(lower)
    )
      appearsClose = true;
  }

  return { human, position, appearsClose, rawText };
}

function parseLateralHint(lower: string): LateralPosition | null {
  if (/\bleft of center\b|\bon the left\b|\bleft side\b/i.test(lower)) return "left";
  if (/\bright of center\b|\bon the right\b|\bright side\b/i.test(lower)) return "right";
  if (/\bcenter(ed)?\b|\bmiddle\b/i.test(lower)) return "center";
  return null;
}

export async function grabCameraSnapshot(
  transport: RosTransport,
  topic: string,
  messageType: typeof IMAGE_TYPE | typeof COMPRESSED_IMAGE_TYPE,
  timeoutMs: number,
): Promise<CameraSnapshot> {
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
    }, timeoutMs);
  });

  const data = msg.data;
  let base64: string;
  if (typeof data === "string") base64 = data;
  else if (Array.isArray(data)) base64 = Buffer.from(data as number[]).toString("base64");
  else if (data != null && typeof (data as { toString: (s: string) => string }).toString === "function")
    base64 = (data as Buffer).toString("base64");
  else throw new Error("No image data");

  let mimeType = "image/jpeg";
  if (messageType === COMPRESSED_IMAGE_TYPE) {
    const fmt = typeof msg.format === "string" ? msg.format.toLowerCase() : "";
    if (fmt.includes("png")) mimeType = "image/png";
    else if (fmt.includes("jpeg") || fmt.includes("jpg")) mimeType = "image/jpeg";
  } else {
    const enc = typeof msg.encoding === "string" ? msg.encoding.toLowerCase() : "";
    if (enc.includes("png")) mimeType = "image/png";
    else if (enc.includes("rgb8") || enc.includes("bgr8")) mimeType = "image/png";
  }

  return { base64, mimeType };
}

export async function callOllamaVision(
  ollamaUrl: string,
  model: string,
  base64Image: string,
  prompt: string,
  timeoutMs: number,
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

export async function callOpenAIVision(
  apiKey: string,
  model: string,
  snapshot: CameraSnapshot,
  prompt: string,
  timeoutMs: number,
  baseUrl?: string,
): Promise<string> {
  const root = (baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const url = `${root}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 120,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              {
                type: "image_url",
                image_url: {
                  url: `data:${snapshot.mimeType};base64,${snapshot.base64}`,
                },
              },
            ],
          },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`OpenAI ${res.status}: ${t.slice(0, 300)}`);
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string | Array<{ type?: string; text?: string }> } }[];
    };
    const choice = data.choices?.[0]?.message?.content;
    if (typeof choice === "string") return choice.trim();
    if (Array.isArray(choice)) {
      const text = choice.map((p) => (p.type === "text" && p.text ? p.text : "")).join("");
      return text.trim();
    }
    return "";
  } finally {
    clearTimeout(timer);
  }
}

export { IMAGE_TYPE, COMPRESSED_IMAGE_TYPE };
