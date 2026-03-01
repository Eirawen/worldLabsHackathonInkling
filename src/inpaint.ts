import * as THREE from "three";
import type { EditOperation, SDFShapeConfig, SelectionBoxState } from "./types";

const FAL_BASE_URL = "https://fal.run";
const FAL_MODEL_CANDIDATES = ["fal-ai/nano-banana-2", "fal-ai/nano-banana"] as const;
const MAX_IMAGE_RETRIES = 1;
const REQUEST_TIMEOUT_MS = 90_000;
const PREVIEW_CANDIDATE_COUNT = 2;

const MIN_SELECTION_EXTENT = 0.05;
const MIN_VOXELS_PER_AXIS = 5;
const MAX_VOXELS_PER_AXIS = 28;
const TARGET_SHAPE_COUNT = 1200;
const MAX_SHAPE_COUNT = 1800;
const SAMPLER_MAX_RESOLUTION = 512;
const DETAIL_GAIN = 0.9;
const TRIPLANAR_BLEND_EXPONENT = 1.8;

type SupportedImageMimeType = "image/png" | "image/jpeg" | "image/webp";

export interface GeneratedPromptImage {
  prompt: string;
  model: string;
  mimeType: SupportedImageMimeType;
  dataUrl: string;
}

export interface InpaintBuildOptions {
  maxShapes?: number;
}

interface FalImageCandidate {
  url?: string;
  data?: string;
  mimeType?: SupportedImageMimeType;
}

interface ImageSampler {
  width: number;
  height: number;
  base: Float32Array;
  blur: Float32Array;
}

export async function generatePromptImage(
  prompt: string,
  _screenshotBase64: string | null,
  selection: SelectionBoxState | null,
  apiKey: string
): Promise<GeneratedPromptImage> {
  const trimmedPrompt = prompt.trim();
  if (!trimmedPrompt) {
    throw new Error("[inpaint] ERROR: prompt is empty");
  }
  if (!apiKey.trim()) {
    throw new Error("[inpaint] ERROR: missing FAL API key");
  }

  const input = buildFalInput(trimmedPrompt, selection);
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_IMAGE_RETRIES; attempt += 1) {
    for (const model of FAL_MODEL_CANDIDATES) {
      try {
        console.log(
          `[inpaint] Generating preview with FAL model=${model} attempt=${attempt + 1}/${MAX_IMAGE_RETRIES + 1}`
        );

        const result = await requestFalImage(model, input, apiKey);
        return {
          prompt: trimmedPrompt,
          model,
          mimeType: result.mimeType,
          dataUrl: result.dataUrl,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        lastError = new Error(`[inpaint] ${message}`);
        console.warn(
          `[inpaint] Preview generation failed model=${model} attempt=${attempt + 1}: ${message}`
        );
      }
    }
  }

  throw lastError ?? new Error("[inpaint] ERROR: failed to generate preview image");
}

export async function buildInpaintOperationsFromImage(
  imageDataUrl: string,
  selection: SelectionBoxState,
  options: InpaintBuildOptions = {}
): Promise<EditOperation[]> {
  const safeSize = new THREE.Vector3(
    Math.max(selection.size.x, MIN_SELECTION_EXTENT),
    Math.max(selection.size.y, MIN_SELECTION_EXTENT),
    Math.max(selection.size.z, MIN_SELECTION_EXTENT)
  );
  const [nx, ny, nz] = resolveVoxelGrid(safeSize, options.maxShapes ?? TARGET_SHAPE_COUNT);
  const sampler = await createImageSampler(imageDataUrl);

  const min = selection.center.clone().sub(safeSize.clone().multiplyScalar(0.5));
  const stepX = safeSize.x / nx;
  const stepY = safeSize.y / ny;
  const stepZ = safeSize.z / nz;

  const halfX = Math.max(stepX * 0.52, 0.01);
  const halfY = Math.max(stepY * 0.52, 0.01);
  const halfZ = Math.max(stepZ * 0.52, 0.01);

  const shapes: SDFShapeConfig[] = [];
  for (let iy = 0; iy < ny; iy += 1) {
    for (let ix = 0; ix < nx; ix += 1) {
      for (let iz = 0; iz < nz; iz += 1) {
        const u = nx > 1 ? ix / (nx - 1) : 0.5;
        const v = ny > 1 ? iy / (ny - 1) : 0.5;
        const w = nz > 1 ? iz / (nz - 1) : 0.5;

        const j = hash3(ix, iy, iz);
        const jitterU = clamp(u + (j - 0.5) * 0.015, 0, 1);
        const jitterV = clamp(v + (j - 0.5) * 0.015, 0, 1);
        const jitterW = clamp(w + (j - 0.5) * 0.015, 0, 1);

        const lx = u * 2 - 1;
        const ly = v * 2 - 1;
        const lz = w * 2 - 1;

        const color = sampleTriplanarColor(
          sampler,
          jitterU,
          jitterV,
          jitterW,
          lx,
          ly,
          lz
        );

        const x = min.x + stepX * (ix + 0.5);
        const y = min.y + stepY * (iy + 0.5);
        const z = min.z + stepZ * (iz + 0.5);

        shapes.push({
          type: "BOX",
          position: [x, y, z],
          scale: [halfX, halfY, halfZ],
          color,
          opacity: 1,
        });
      }
    }
  }

  const softEdge = clamp(Math.min(stepX, stepY, stepZ) * 0.18, 0.004, 0.08);
  const operation: EditOperation = {
    action: "recolor",
    blendMode: "SET_RGB",
    softEdge,
    sdfSmooth: clamp(softEdge * 0.55, 0, 0.05),
    shapes,
  };

  console.log(
    `[inpaint] Built high-detail operation: shapes=${shapes.length} grid=${nx}x${ny}x${nz} size=[${safeSize
      .toArray()
      .map((value) => value.toFixed(3))
      .join(", ")}]`
  );

  return [operation];
}

async function requestFalImage(
  modelId: string,
  input: FalImageInput,
  apiKey: string
): Promise<{ dataUrl: string; mimeType: SupportedImageMimeType }> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${FAL_BASE_URL}/${modelId}`, {
      method: "POST",
      headers: {
        Authorization: `Key ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error(`FAL request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`FAL request failed (${response.status}): ${text.slice(0, 500)}`);
  }

  const payload = (await response.json()) as unknown;
  const candidates = extractFalImages(payload);
  if (candidates.length === 0) {
    throw new Error("FAL response did not include usable image candidates.");
  }

  const resolved = await Promise.all(
    candidates.map(async (candidate, index) => {
      const mimeType = candidate.mimeType ?? "image/png";
      if (candidate.data) {
        const dataUrl = toDataUrl(candidate.data, mimeType);
        const sharpness = await scoreImageSharpness(dataUrl);
        return { dataUrl, mimeType, sharpness, index };
      }
      if (!candidate.url) {
        return null;
      }
      const inferredMimeType = candidate.mimeType ?? inferMimeFromUrl(candidate.url);
      const dataUrl = await fetchImageUrlAsDataUrl(candidate.url, inferredMimeType);
      const sharpness = await scoreImageSharpness(dataUrl);
      return { dataUrl, mimeType: inferredMimeType, sharpness, index };
    })
  );

  const valid = resolved.filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  if (valid.length === 0) {
    throw new Error("FAL returned images but none could be decoded.");
  }

  valid.sort((a, b) => b.sharpness - a.sharpness || a.index - b.index);
  const best = valid[0];
  console.log(
    `[inpaint] Selected sharpest preview from ${valid.length} candidate(s), score=${best.sharpness.toFixed(2)}`
  );
  return {
    dataUrl: best.dataUrl,
    mimeType: best.mimeType,
  };
}

function buildFalInput(
  prompt: string,
  selection: SelectionBoxState | null
): FalImageInput {
  const aspectRatio = selection
    ? nearestAspectRatio(selection.size.x, selection.size.z)
    : "1:1";

  return {
    prompt: buildImagePrompt(prompt, selection),
    num_images: PREVIEW_CANDIDATE_COUNT,
    output_format: "png",
    aspect_ratio: aspectRatio,
    sync_mode: true,
  };
}

function buildImagePrompt(prompt: string, selection: SelectionBoxState | null): string {
  const lines: string[] = [];
  lines.push("Create a high-quality texture-like reference image for recoloring a 3D scene region.");
  lines.push("Avoid blur. Keep crisp local detail and strong edges.");
  lines.push("No text, no logos, no borders, no watermark.");
  lines.push("Strong coherent color palette and clear material cues.");
  if (selection) {
    lines.push(
      `Selected region size (meters): [${selection.size.x.toFixed(2)}, ${selection.size.y.toFixed(2)}, ${selection.size.z.toFixed(2)}].`
    );
  }
  lines.push(`Style prompt: ${prompt}`);
  return lines.join("\n");
}

function extractFalImages(payload: unknown): FalImageCandidate[] {
  if (!isRecord(payload)) {
    return [];
  }

  const images = payload.images;
  if (!Array.isArray(images) || images.length === 0) {
    return [];
  }

  const out: FalImageCandidate[] = [];
  for (const entry of images) {
    if (!isRecord(entry)) {
      continue;
    }

    const mimeType = toSupportedImageMime(entry.content_type);
    const url =
      typeof entry.url === "string" && entry.url.trim()
        ? entry.url.trim()
        : undefined;
    const data =
      typeof entry.b64_json === "string" && entry.b64_json.trim()
        ? entry.b64_json.trim()
        : undefined;
    if (!url && !data) {
      continue;
    }

    out.push({ url, data, mimeType });
  }
  return out;
}

async function fetchImageUrlAsDataUrl(
  url: string,
  fallbackMimeType: SupportedImageMimeType
): Promise<string> {
  if (url.startsWith("data:image/")) {
    return url;
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download generated image (${response.status}).`);
  }

  const blob = await response.blob();
  const mimeType = toSupportedImageMime(blob.type) ?? fallbackMimeType;
  const data = await blobToBase64(blob);
  return toDataUrl(data, mimeType);
}

async function blobToBase64(blob: Blob): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = reader.result;
      if (typeof value === "string") {
        resolve(value);
      } else {
        reject(new Error("Failed to encode blob as data URL"));
      }
    };
    reader.onerror = () => reject(new Error("Failed to read blob"));
    reader.readAsDataURL(blob);
  });

  const match = dataUrl.match(/^data:image\/(?:png|jpeg|jpg|webp);base64,(.+)$/i);
  if (!match?.[1]) {
    throw new Error("Unexpected data URL while encoding downloaded image.");
  }
  return match[1];
}

function toDataUrl(data: string, mimeType: SupportedImageMimeType): string {
  const compact = data.replace(/\s+/g, "");
  if (/^data:image\/(?:png|jpeg|jpg|webp);base64,/i.test(compact)) {
    return compact;
  }
  return `data:${mimeType};base64,${compact}`;
}

function nearestAspectRatio(width: number, depth: number): FalAspectRatio {
  const ratio = width > 0 && depth > 0 ? width / depth : 1;
  const candidates: Array<{ ratio: FalAspectRatio; value: number }> = [
    { ratio: "1:1", value: 1 },
    { ratio: "4:3", value: 4 / 3 },
    { ratio: "3:4", value: 3 / 4 },
    { ratio: "16:9", value: 16 / 9 },
    { ratio: "9:16", value: 9 / 16 },
    { ratio: "3:2", value: 3 / 2 },
    { ratio: "2:3", value: 2 / 3 },
  ];

  let best = candidates[0];
  let bestError = Math.abs(ratio - best.value);
  for (const candidate of candidates.slice(1)) {
    const error = Math.abs(ratio - candidate.value);
    if (error < bestError) {
      best = candidate;
      bestError = error;
    }
  }
  return best.ratio;
}

function inferMimeFromUrl(url: string): SupportedImageMimeType {
  const lower = url.toLowerCase();
  if (lower.includes(".jpg") || lower.includes(".jpeg")) {
    return "image/jpeg";
  }
  if (lower.includes(".webp")) {
    return "image/webp";
  }
  return "image/png";
}

function toSupportedImageMime(value: unknown): SupportedImageMimeType | undefined {
  if (value === "image/png" || value === "image/jpeg" || value === "image/webp") {
    return value;
  }
  return undefined;
}

function resolveVoxelGrid(size: THREE.Vector3, targetShapes: number): [number, number, number] {
  const sx = Math.max(size.x, MIN_SELECTION_EXTENT);
  const sy = Math.max(size.y, MIN_SELECTION_EXTENT);
  const sz = Math.max(size.z, MIN_SELECTION_EXTENT);

  const clampedTarget = clampInt(targetShapes, 150, MAX_SHAPE_COUNT);
  const densityScale = Math.cbrt(clampedTarget / Math.max(sx * sy * sz, 1e-6));

  let nx = clampInt(Math.round(sx * densityScale), MIN_VOXELS_PER_AXIS, MAX_VOXELS_PER_AXIS);
  let ny = clampInt(Math.round(sy * densityScale), MIN_VOXELS_PER_AXIS, MAX_VOXELS_PER_AXIS);
  let nz = clampInt(Math.round(sz * densityScale), MIN_VOXELS_PER_AXIS, MAX_VOXELS_PER_AXIS);

  while (nx * ny * nz > MAX_SHAPE_COUNT) {
    if (nx >= ny && nx >= nz && nx > MIN_VOXELS_PER_AXIS) {
      nx -= 1;
      continue;
    }
    if (ny >= nx && ny >= nz && ny > MIN_VOXELS_PER_AXIS) {
      ny -= 1;
      continue;
    }
    if (nz > MIN_VOXELS_PER_AXIS) {
      nz -= 1;
      continue;
    }
    break;
  }

  return [nx, ny, nz];
}

async function createImageSampler(imageDataUrl: string): Promise<ImageSampler> {
  const image = await loadImage(imageDataUrl);
  const scale = Math.min(1, SAMPLER_MAX_RESOLUTION / Math.max(image.width, image.height));
  const width = Math.max(16, Math.round(image.width * scale));
  const height = Math.max(16, Math.round(image.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    throw new Error("[inpaint] ERROR: could not create 2D context for sampling");
  }

  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(image, 0, 0, width, height);
  const imageData = ctx.getImageData(0, 0, width, height).data;

  const base = new Float32Array(width * height * 3);
  for (let i = 0; i < width * height; i += 1) {
    const src = i * 4;
    const dst = i * 3;
    base[dst] = imageData[src] / 255;
    base[dst + 1] = imageData[src + 1] / 255;
    base[dst + 2] = imageData[src + 2] / 255;
  }

  const blur = blur3x3(base, width, height);
  return { width, height, base, blur };
}

function sampleTriplanarColor(
  sampler: ImageSampler,
  u: number,
  v: number,
  w: number,
  lx: number,
  ly: number,
  lz: number
): [number, number, number] {
  const wx = Math.pow(Math.abs(lx) + 0.02, TRIPLANAR_BLEND_EXPONENT);
  const wy = Math.pow(Math.abs(ly) + 0.02, TRIPLANAR_BLEND_EXPONENT);
  const wz = Math.pow(Math.abs(lz) + 0.02, TRIPLANAR_BLEND_EXPONENT);
  const weightSum = wx + wy + wz;

  const xPlane = sampleEnhanced(sampler, w, v);
  const yPlane = sampleEnhanced(sampler, u, w);
  const zPlane = sampleEnhanced(sampler, u, v);

  return [
    clamp((xPlane[0] * wx + yPlane[0] * wy + zPlane[0] * wz) / weightSum, 0, 1),
    clamp((xPlane[1] * wx + yPlane[1] * wy + zPlane[1] * wz) / weightSum, 0, 1),
    clamp((xPlane[2] * wx + yPlane[2] * wy + zPlane[2] * wz) / weightSum, 0, 1),
  ];
}

function sampleEnhanced(
  sampler: ImageSampler,
  u: number,
  v: number
): [number, number, number] {
  const base = sampleBilinear(sampler.base, sampler.width, sampler.height, u, v);
  const blur = sampleBilinear(sampler.blur, sampler.width, sampler.height, u, v);
  return [
    clamp(base[0] + DETAIL_GAIN * (base[0] - blur[0]), 0, 1),
    clamp(base[1] + DETAIL_GAIN * (base[1] - blur[1]), 0, 1),
    clamp(base[2] + DETAIL_GAIN * (base[2] - blur[2]), 0, 1),
  ];
}

function sampleBilinear(
  buffer: Float32Array,
  width: number,
  height: number,
  u: number,
  v: number
): [number, number, number] {
  const x = clamp(u, 0, 1) * (width - 1);
  const y = clamp(v, 0, 1) * (height - 1);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, width - 1);
  const y1 = Math.min(y0 + 1, height - 1);
  const tx = x - x0;
  const ty = y - y0;

  const c00 = readRgb(buffer, width, x0, y0);
  const c10 = readRgb(buffer, width, x1, y0);
  const c01 = readRgb(buffer, width, x0, y1);
  const c11 = readRgb(buffer, width, x1, y1);

  const topR = c00[0] * (1 - tx) + c10[0] * tx;
  const topG = c00[1] * (1 - tx) + c10[1] * tx;
  const topB = c00[2] * (1 - tx) + c10[2] * tx;
  const bottomR = c01[0] * (1 - tx) + c11[0] * tx;
  const bottomG = c01[1] * (1 - tx) + c11[1] * tx;
  const bottomB = c01[2] * (1 - tx) + c11[2] * tx;

  return [
    topR * (1 - ty) + bottomR * ty,
    topG * (1 - ty) + bottomG * ty,
    topB * (1 - ty) + bottomB * ty,
  ];
}

function readRgb(
  buffer: Float32Array,
  width: number,
  x: number,
  y: number
): [number, number, number] {
  const idx = (y * width + x) * 3;
  return [buffer[idx], buffer[idx + 1], buffer[idx + 2]];
}

function blur3x3(buffer: Float32Array, width: number, height: number): Float32Array {
  const out = new Float32Array(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let count = 0;
      for (let oy = -1; oy <= 1; oy += 1) {
        const sy = clampInt(y + oy, 0, height - 1);
        for (let ox = -1; ox <= 1; ox += 1) {
          const sx = clampInt(x + ox, 0, width - 1);
          const src = (sy * width + sx) * 3;
          r += buffer[src];
          g += buffer[src + 1];
          b += buffer[src + 2];
          count += 1;
        }
      }
      const dst = (y * width + x) * 3;
      out[dst] = r / count;
      out[dst + 1] = g / count;
      out[dst + 2] = b / count;
    }
  }
  return out;
}

async function scoreImageSharpness(dataUrl: string): Promise<number> {
  const image = await loadImage(dataUrl);
  const maxDim = 192;
  const scale = Math.min(1, maxDim / Math.max(image.width, image.height));
  const width = Math.max(24, Math.round(image.width * scale));
  const height = Math.max(24, Math.round(image.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    return 0;
  }

  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(image, 0, 0, width, height);
  const data = ctx.getImageData(0, 0, width, height).data;

  const luma = new Float32Array(width * height);
  for (let i = 0; i < width * height; i += 1) {
    const src = i * 4;
    luma[i] = 0.2126 * data[src] + 0.7152 * data[src + 1] + 0.0722 * data[src + 2];
  }

  let sum = 0;
  let sumSq = 0;
  let count = 0;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i = y * width + x;
      const lap =
        4 * luma[i] -
        luma[i - 1] -
        luma[i + 1] -
        luma[i - width] -
        luma[i + width];
      sum += lap;
      sumSq += lap * lap;
      count += 1;
    }
  }

  if (count === 0) {
    return 0;
  }
  const mean = sum / count;
  return sumSq / count - mean * mean;
}

async function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return await new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () =>
      reject(new Error("[inpaint] ERROR: failed to decode generated image"));
    image.src = dataUrl;
  });
}

function hash3(x: number, y: number, z: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return s - Math.floor(s);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function clampInt(value: number, min: number, max: number): number {
  return Math.round(clamp(value, min, max));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

type FalAspectRatio =
  | "1:1"
  | "16:9"
  | "9:16"
  | "4:3"
  | "3:4"
  | "3:2"
  | "2:3";

interface FalImageInput {
  prompt: string;
  num_images: number;
  output_format: "jpeg" | "png";
  aspect_ratio: FalAspectRatio;
  sync_mode: boolean;
}
