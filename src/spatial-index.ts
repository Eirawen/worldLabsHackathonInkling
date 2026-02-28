import type { SplatMesh } from "@sparkjsdev/spark";
import * as THREE from "three";
import type { SpatialGrid, VoxelCell } from "./types";

export interface SpatialIndexOptions {
  resolution: [number, number, number];
  cropYFraction: [number, number];
  logPrefix: string;
}

export interface CroppedBoundsResult {
  bounds: THREE.Box3;
  usedFallback: boolean;
}

type VoxelAccumulator = {
  gridPos: [number, number, number];
  count: number;
  sumPos: THREE.Vector3;
  sumColor: THREE.Vector3;
  sumColorSq: THREE.Vector3;
  min: THREE.Vector3;
  max: THREE.Vector3;
  splatIndices: number[];
};

const DEFAULT_OPTIONS: SpatialIndexOptions = {
  resolution: [20, 20, 20],
  cropYFraction: [0.1, 0.1],
  logPrefix: "[spatial]",
};

export function gridKey(x: number, y: number, z: number): string {
  return `${x},${y},${z}`;
}

export function computeNominalCellSize(
  bounds: THREE.Box3,
  resolution: [number, number, number]
): THREE.Vector3 {
  const size = new THREE.Vector3();
  bounds.getSize(size);

  return new THREE.Vector3(
    safeDiv(size.x, resolution[0]),
    safeDiv(size.y, resolution[1]),
    safeDiv(size.z, resolution[2])
  );
}

export function computeCroppedBounds(
  rawBounds: THREE.Box3,
  cropFractions: [number, number] = [0.1, 0.1]
): CroppedBoundsResult {
  const bounds = rawBounds.clone();
  const size = new THREE.Vector3();
  bounds.getSize(size);

  const height = size.y;
  if (!Number.isFinite(height) || height <= 0) {
    return { bounds, usedFallback: true };
  }

  const [cropBottom, cropTop] = cropFractions;
  const minY = rawBounds.min.y + height * cropBottom;
  const maxY = rawBounds.max.y - height * cropTop;

  if (!(maxY > minY)) {
    return { bounds, usedFallback: true };
  }

  bounds.min.y = minY;
  bounds.max.y = maxY;
  return { bounds, usedFallback: false };
}

export function worldPosToGridCoord(
  worldPos: THREE.Vector3,
  gridBounds: THREE.Box3,
  resolution: [number, number, number]
): [number, number, number] | null {
  if (!gridBounds.containsPoint(worldPos)) {
    return null;
  }

  const size = new THREE.Vector3();
  gridBounds.getSize(size);

  const nx = normalizeAxis(worldPos.x, gridBounds.min.x, size.x);
  const ny = normalizeAxis(worldPos.y, gridBounds.min.y, size.y);
  const nz = normalizeAxis(worldPos.z, gridBounds.min.z, size.z);

  return [
    normalizedToIndex(nx, resolution[0]),
    normalizedToIndex(ny, resolution[1]),
    normalizedToIndex(nz, resolution[2]),
  ];
}

export function buildSpatialGrid(
  splatMesh: SplatMesh,
  options: Partial<SpatialIndexOptions> = {}
): SpatialGrid {
  const config: SpatialIndexOptions = {
    ...DEFAULT_OPTIONS,
    ...options,
  };
  const [rx, ry, rz] = config.resolution;
  const logPrefix = config.logPrefix;
  const rawBounds = splatMesh.getBoundingBox();

  if (isDegenerateBounds(rawBounds)) {
    console.warn(`${logPrefix} Degenerate bounding box; returning empty grid`);
    return {
      resolution: config.resolution,
      worldBounds: rawBounds.clone(),
      cellSize: new THREE.Vector3(0, 0, 0),
      cells: new Map<string, VoxelCell>(),
    };
  }

  const { bounds: croppedBounds, usedFallback } = computeCroppedBounds(
    rawBounds,
    config.cropYFraction
  );
  if (usedFallback) {
    console.warn(`${logPrefix} Y-crop fallback to raw bounds (scene too small/degenerate)`);
  }

  const cellSize = computeNominalCellSize(croppedBounds, config.resolution);
  const nominalCellVolume = Math.max(cellSize.x * cellSize.y * cellSize.z, 1e-9);

  const accumulators = new Map<string, VoxelAccumulator>();
  let totalSplats = 0;
  let indexedSplats = 0;
  const start = nowMs();

  splatMesh.forEachSplat((index, center, _scales, _quat, _opacity, color) => {
    totalSplats += 1;

    const coord = worldPosToGridCoord(center, croppedBounds, config.resolution);
    if (!coord) {
      return;
    }

    const [gx, gy, gz] = coord;
    const key = gridKey(gx, gy, gz);
    let acc = accumulators.get(key);
    if (!acc) {
      acc = {
        gridPos: [gx, gy, gz],
        count: 0,
        sumPos: new THREE.Vector3(),
        sumColor: new THREE.Vector3(),
        sumColorSq: new THREE.Vector3(),
        min: new THREE.Vector3(center.x, center.y, center.z),
        max: new THREE.Vector3(center.x, center.y, center.z),
        splatIndices: [],
      };
      accumulators.set(key, acc);
    }

    indexedSplats += 1;
    acc.count += 1;
    acc.sumPos.add(center);
    acc.sumColor.x += color.r;
    acc.sumColor.y += color.g;
    acc.sumColor.z += color.b;
    acc.sumColorSq.x += color.r * color.r;
    acc.sumColorSq.y += color.g * color.g;
    acc.sumColorSq.z += color.b * color.b;
    acc.min.min(center);
    acc.max.max(center);
    acc.splatIndices.push(index);
  });

  const cells = new Map<string, VoxelCell>();
  for (const [key, acc] of accumulators) {
    cells.set(key, finalizeVoxelCell(acc, nominalCellVolume));
  }

  const elapsedMs = nowMs() - start;
  console.log(
    `${logPrefix} Built grid ${rx}x${ry}x${rz}: occupied=${cells.size}, indexedSplats=${indexedSplats}/${totalSplats}, elapsed=${elapsedMs.toFixed(1)}ms`
  );

  return {
    resolution: config.resolution,
    worldBounds: croppedBounds,
    cellSize,
    cells,
  };
}

export function getCellAtWorldPos(
  grid: SpatialGrid,
  pos: THREE.Vector3
): VoxelCell | null {
  const coord = worldPosToGridCoord(pos, grid.worldBounds, grid.resolution);
  if (!coord) {
    return null;
  }

  return grid.cells.get(gridKey(coord[0], coord[1], coord[2])) ?? null;
}

export function getNeighborCells(
  grid: SpatialGrid,
  cell: VoxelCell,
  radius: number
): VoxelCell[] {
  const out: VoxelCell[] = [];
  const [cx, cy, cz] = cell.gridPos;
  const [rx, ry, rz] = grid.resolution;
  const r = Math.max(0, Math.floor(radius));

  for (let x = Math.max(0, cx - r); x <= Math.min(rx - 1, cx + r); x += 1) {
    for (let y = Math.max(0, cy - r); y <= Math.min(ry - 1, cy + r); y += 1) {
      for (let z = Math.max(0, cz - r); z <= Math.min(rz - 1, cz + r); z += 1) {
        const neighbor = grid.cells.get(gridKey(x, y, z));
        if (neighbor) {
          out.push(neighbor);
        }
      }
    }
  }

  return out;
}

export function serializeSpatialGridForLLM(
  grid: SpatialGrid,
  options: { maxCells?: number } = {}
): string {
  let cells = Array.from(grid.cells.entries());

  if (typeof options.maxCells === "number" && options.maxCells >= 0 && cells.length > options.maxCells) {
    cells = cells
      .sort((a, b) => b[1].splatCount - a[1].splatCount)
      .slice(0, options.maxCells);
    console.log(`[spatial] serializeSpatialGridForLLM truncated to ${cells.length} cells`);
  }

  const payload = {
    resolution: grid.resolution,
    worldBounds: {
      min: grid.worldBounds.min.toArray(),
      max: grid.worldBounds.max.toArray(),
    },
    cellSize: grid.cellSize.toArray(),
    cells: cells.map(([key, cell]) => ({
      key,
      gridPos: cell.gridPos,
      worldCenter: cell.worldCenter.toArray(),
      worldBounds: {
        min: cell.worldBounds.min.toArray(),
        max: cell.worldBounds.max.toArray(),
      },
      splatCount: cell.splatCount,
      avgColor: [cell.avgColor.r, cell.avgColor.g, cell.avgColor.b],
      colorVariance: cell.colorVariance,
      density: cell.density,
    })),
  };

  return JSON.stringify(payload);
}

function finalizeVoxelCell(acc: VoxelAccumulator, nominalCellVolume: number): VoxelCell {
  const invCount = 1 / acc.count;
  const center = acc.sumPos.clone().multiplyScalar(invCount);
  const avgR = acc.sumColor.x * invCount;
  const avgG = acc.sumColor.y * invCount;
  const avgB = acc.sumColor.z * invCount;
  const varianceR = Math.max(0, acc.sumColorSq.x * invCount - avgR * avgR);
  const varianceG = Math.max(0, acc.sumColorSq.y * invCount - avgG * avgG);
  const varianceB = Math.max(0, acc.sumColorSq.z * invCount - avgB * avgB);
  const colorVariance = (varianceR + varianceG + varianceB) / 3;

  return {
    gridPos: acc.gridPos,
    worldCenter: center,
    worldBounds: new THREE.Box3(acc.min.clone(), acc.max.clone()),
    splatCount: acc.count,
    avgColor: new THREE.Color(avgR, avgG, avgB),
    colorVariance,
    density: acc.count / nominalCellVolume,
    splatIndices: acc.splatIndices,
  };
}

function isDegenerateBounds(bounds: THREE.Box3): boolean {
  const size = new THREE.Vector3();
  bounds.getSize(size);
  return (
    !Number.isFinite(bounds.min.x) ||
    !Number.isFinite(bounds.min.y) ||
    !Number.isFinite(bounds.min.z) ||
    !Number.isFinite(bounds.max.x) ||
    !Number.isFinite(bounds.max.y) ||
    !Number.isFinite(bounds.max.z) ||
    size.x <= 0 ||
    size.y <= 0 ||
    size.z <= 0
  );
}

function normalizeAxis(value: number, min: number, size: number): number {
  if (!Number.isFinite(size) || size <= 0) {
    return 0;
  }
  return THREE.MathUtils.clamp((value - min) / size, 0, 1);
}

function normalizedToIndex(normalized: number, resolution: number): number {
  if (resolution <= 1) {
    return 0;
  }
  if (normalized >= 1) {
    return resolution - 1;
  }
  return THREE.MathUtils.clamp(Math.floor(normalized * resolution), 0, resolution - 1);
}

function safeDiv(n: number, d: number): number {
  return d > 0 ? n / d : 0;
}

function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}
