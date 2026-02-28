import { PackedSplats, SplatMesh } from "@sparkjsdev/spark";
import * as THREE from "three";
import type { AssetEntry, EditOperation, SDFShapeConfig } from "./types";

type CapturedSplat = {
  center: THREE.Vector3;
  scales: THREE.Vector3;
  quaternion: THREE.Quaternion;
  opacity: number;
  color: THREE.Color;
};

type CompiledShape = {
  type: "SPHERE" | "ELLIPSOID" | "BOX";
  position: THREE.Vector3;
  inverseRotation: THREE.Quaternion;
  radius: number;
  scale: THREE.Vector3;
};

const assets: AssetEntry[] = [];

const MIN_ASSET_SPLATS = 24;
const MAX_EXTRACTED_SPLATS = 120_000;
const MIN_OPACITY = 0.1;
const MAX_COLOR_DISTANCE = 0.52;
const EPSILON = 1e-6;

const tmpLocal = new THREE.Vector3();

export function extractAssetFromDeleteOperation(
  op: EditOperation,
  splatMesh: SplatMesh,
  sourceScene: string
): AssetEntry | null {
  if (op.action !== "delete" || !op.extractAsset) {
    return null;
  }

  const startMs = nowMs();
  const compiledShapes = compileSupportedShapes(op.shapes);
  if (compiledShapes.length === 0) {
    console.warn("[asset-library] No supported delete shapes found for extraction");
    return null;
  }

  const candidates: CapturedSplat[] = [];
  let insideRegionCount = 0;
  let filteredLowOpacity = 0;

  splatMesh.forEachSplat((_, center, scales, quaternion, opacity, color) => {
    if (!pointInsideAnyCompiledShape(center, compiledShapes)) {
      return;
    }

    insideRegionCount += 1;
    if (opacity < MIN_OPACITY) {
      filteredLowOpacity += 1;
      return;
    }

    candidates.push({
      center: new THREE.Vector3().copy(center),
      scales: new THREE.Vector3().copy(scales),
      quaternion: new THREE.Quaternion().copy(quaternion),
      opacity,
      color: new THREE.Color().copy(color),
    });
  });

  if (candidates.length < MIN_ASSET_SPLATS) {
    console.log(
      `[asset-library] Extraction skipped (too few candidates): inside=${insideRegionCount}, kept=${candidates.length}`
    );
    return null;
  }

  const avgColor = averageColor(candidates);
  const colorFiltered = candidates.filter(
    (splat) => colorDistance(splat.color, avgColor) <= MAX_COLOR_DISTANCE
  );

  const kept =
    colorFiltered.length >= MIN_ASSET_SPLATS ? colorFiltered : candidates;

  if (colorFiltered.length < MIN_ASSET_SPLATS) {
    console.log(
      `[asset-library] Color filter fallback: before=${candidates.length} after=${colorFiltered.length}`
    );
  }

  const truncated = kept.slice(0, MAX_EXTRACTED_SPLATS);
  const centroid = computeCentroid(truncated);
  const bounds = computeBounds(truncated);

  const packedSplats = new PackedSplats({ maxSplats: truncated.length + 1 });
  for (const splat of truncated) {
    const localCenter = new THREE.Vector3().copy(splat.center).sub(centroid);
    packedSplats.pushSplat(
      localCenter,
      splat.scales,
      splat.quaternion,
      splat.opacity,
      splat.color
    );
  }
  packedSplats.needsUpdate = true;

  const entry: AssetEntry = {
    id: buildAssetId(),
    label: normalizeAssetLabel(op.assetLabel),
    sourceScene,
    extractedAt: new Date(),
    splats: packedSplats,
    thumbnailDataUrl: buildPlaceholderThumbnail(normalizeAssetLabel(op.assetLabel)),
    originalPosition: centroid,
    bounds,
    splatCount: truncated.length,
  };

  const elapsedMs = nowMs() - startMs;
  console.log(
    `[asset-library] Extracted asset "${entry.label}" splats=${entry.splatCount} inside=${insideRegionCount} filteredOpacity=${filteredLowOpacity} keptAfterColor=${kept.length} ms=${elapsedMs.toFixed(1)}`
  );

  return entry;
}

export function addAsset(entry: AssetEntry): void {
  assets.unshift(entry);
  console.log(
    `[asset-library] Added asset id=${entry.id} label="${entry.label}" total=${assets.length}`
  );
}

export function listAssets(): readonly AssetEntry[] {
  return assets;
}

export function getAssetById(id: string): AssetEntry | undefined {
  return assets.find((asset) => asset.id === id);
}

export function createPlacedAssetMesh(
  asset: AssetEntry,
  worldPos: THREE.Vector3
): SplatMesh {
  const mesh = new SplatMesh({ packedSplats: asset.splats });
  mesh.maxSh = 0;
  mesh.quaternion.set(1, 0, 0, 0);
  mesh.position.copy(worldPos);
  console.log(
    `[asset-library] Created placed mesh for "${asset.label}" at [${worldPos.x.toFixed(3)}, ${worldPos.y.toFixed(3)}, ${worldPos.z.toFixed(3)}]`
  );
  return mesh;
}

function compileSupportedShapes(shapes: SDFShapeConfig[]): CompiledShape[] {
  const compiled: CompiledShape[] = [];

  for (const shape of shapes) {
    if (shape.type !== "SPHERE" && shape.type !== "ELLIPSOID" && shape.type !== "BOX") {
      console.warn(`[asset-library] Skipping unsupported extraction shape type=${shape.type}`);
      continue;
    }

    const position = new THREE.Vector3(
      shape.position[0],
      shape.position[1],
      shape.position[2]
    );
    const rotation = shape.rotation
      ? new THREE.Quaternion(
          shape.rotation[0],
          shape.rotation[1],
          shape.rotation[2],
          shape.rotation[3]
        )
      : new THREE.Quaternion(0, 0, 0, 1);

    const scale = shape.scale
      ? new THREE.Vector3(shape.scale[0], shape.scale[1], shape.scale[2])
      : new THREE.Vector3(shape.radius ?? 0.5, shape.radius ?? 0.5, shape.radius ?? 0.5);

    compiled.push({
      type: shape.type,
      position,
      inverseRotation: rotation.clone().invert(),
      radius: shape.radius ?? Math.max(scale.x, scale.y, scale.z),
      scale,
    });
  }

  return compiled;
}

function pointInsideAnyCompiledShape(
  point: THREE.Vector3,
  compiledShapes: CompiledShape[]
): boolean {
  for (const shape of compiledShapes) {
    if (pointInsideCompiledShape(point, shape)) {
      return true;
    }
  }
  return false;
}

function pointInsideCompiledShape(point: THREE.Vector3, shape: CompiledShape): boolean {
  tmpLocal.copy(point).sub(shape.position);
  tmpLocal.applyQuaternion(shape.inverseRotation);

  switch (shape.type) {
    case "SPHERE": {
      const radius = Math.max(shape.radius, EPSILON);
      return tmpLocal.lengthSq() <= radius * radius;
    }
    case "ELLIPSOID": {
      const rx = Math.max(shape.scale.x, EPSILON);
      const ry = Math.max(shape.scale.y, EPSILON);
      const rz = Math.max(shape.scale.z, EPSILON);
      const normalized =
        (tmpLocal.x * tmpLocal.x) / (rx * rx) +
        (tmpLocal.y * tmpLocal.y) / (ry * ry) +
        (tmpLocal.z * tmpLocal.z) / (rz * rz);
      return normalized <= 1;
    }
    case "BOX": {
      return (
        Math.abs(tmpLocal.x) <= Math.max(shape.scale.x, EPSILON) &&
        Math.abs(tmpLocal.y) <= Math.max(shape.scale.y, EPSILON) &&
        Math.abs(tmpLocal.z) <= Math.max(shape.scale.z, EPSILON)
      );
    }
    default:
      return false;
  }
}

function averageColor(splats: CapturedSplat[]): THREE.Color {
  let r = 0;
  let g = 0;
  let b = 0;

  for (const splat of splats) {
    r += splat.color.r;
    g += splat.color.g;
    b += splat.color.b;
  }

  const inv = 1 / Math.max(1, splats.length);
  return new THREE.Color(r * inv, g * inv, b * inv);
}

function colorDistance(a: THREE.Color, b: THREE.Color): number {
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function computeCentroid(splats: CapturedSplat[]): THREE.Vector3 {
  const centroid = new THREE.Vector3();
  if (splats.length === 0) {
    return centroid;
  }

  for (const splat of splats) {
    centroid.add(splat.center);
  }

  centroid.multiplyScalar(1 / splats.length);
  return centroid;
}

function computeBounds(splats: CapturedSplat[]): THREE.Box3 {
  const bounds = new THREE.Box3();
  if (splats.length === 0) {
    bounds.set(
      new THREE.Vector3(-0.001, -0.001, -0.001),
      new THREE.Vector3(0.001, 0.001, 0.001)
    );
    return bounds;
  }

  for (const splat of splats) {
    bounds.expandByPoint(splat.center);
  }

  return bounds;
}

function normalizeAssetLabel(label: string | undefined): string {
  const trimmed = label?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : "extracted asset";
}

function buildAssetId(): string {
  return `asset_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function buildPlaceholderThumbnail(label: string): string {
  const safeLabel = label.replace(/[<>&]/g, "");
  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="256" height="144" viewBox="0 0 256 144">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#23303a"/>
      <stop offset="100%" stop-color="#11161b"/>
    </linearGradient>
  </defs>
  <rect width="256" height="144" fill="url(#g)"/>
  <text x="12" y="76" fill="#f3f8ff" font-family="sans-serif" font-size="16">${safeLabel}</text>
</svg>`.trim();

  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}
