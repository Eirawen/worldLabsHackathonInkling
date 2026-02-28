import * as THREE from "three";
import { getCellAtWorldPos, gridKey } from "./spatial-index";
import type { SDFShapeConfig, SpatialGrid, VoxelCell } from "./types";

export interface SelectionOptions {
  colorDistanceThreshold?: number;
  maxVisitedCells?: number;
  maxDepth?: number;
  maxClusterCells?: number;
  minClusterCells?: number;
  boxPadding?: number;
}

export interface SelectionResult {
  seedCellKey: string;
  clusterCellKeys: string[];
  clusterBounds: THREE.Box3;
  clusterCenter: THREE.Vector3;
  suggestedShape: SDFShapeConfig;
  confidence: number;
  diagnostics: {
    visitedCells: number;
    rejectedCells: number;
    reason: string[];
  };
}

const DEFAULT_OPTIONS: Required<SelectionOptions> = {
  colorDistanceThreshold: 0.24,
  maxVisitedCells: 180,
  maxDepth: 4,
  maxClusterCells: 90,
  minClusterCells: 2,
  boxPadding: 1.08,
};

type QueueItem = {
  key: string;
  cell: VoxelCell;
  depth: number;
};

export function buildLocalSelection(
  grid: SpatialGrid,
  click: THREE.Vector3,
  options: SelectionOptions = {}
): SelectionResult | null {
  const config = { ...DEFAULT_OPTIONS, ...options };
  const seedCell = getCellAtWorldPos(grid, click);
  if (!seedCell) {
    console.log("[selection] No seed cell at click position");
    return null;
  }

  const seedKey = gridKey(...seedCell.gridPos);
  const seedColor = seedCell.avgColor;
  const queue: QueueItem[] = [{ key: seedKey, cell: seedCell, depth: 0 }];
  const visited = new Set<string>();
  const accepted = new Map<string, VoxelCell>();
  let rejectedCells = 0;
  const reasons: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current.key)) {
      continue;
    }
    visited.add(current.key);

    if (visited.size > config.maxVisitedCells) {
      reasons.push("maxVisitedCells");
      break;
    }

    const colorDistance = colorDistance3(current.cell.avgColor, seedColor);
    const passColor = colorDistance <= config.colorDistanceThreshold;
    const forceSeed = current.key === seedKey;
    if (!forceSeed && !passColor) {
      rejectedCells += 1;
      continue;
    }

    accepted.set(current.key, current.cell);
    if (accepted.size >= config.maxClusterCells) {
      reasons.push("maxClusterCells");
      break;
    }

    if (current.depth >= config.maxDepth) {
      continue;
    }
    for (const neighbor of getFaceNeighbors(grid, current.cell)) {
      const neighborKey = gridKey(...neighbor.gridPos);
      if (!visited.has(neighborKey)) {
        queue.push({ key: neighborKey, cell: neighbor, depth: current.depth + 1 });
      }
    }
  }

  if (accepted.size < config.minClusterCells) {
    console.log(
      `[selection] Cluster too small accepted=${accepted.size} min=${config.minClusterCells}`
    );
    return null;
  }

  const clusterCells = Array.from(accepted.values());
  const clusterBounds = new THREE.Box3();
  const weightedCenter = new THREE.Vector3();
  let totalWeight = 0;
  let avgColorDistance = 0;

  for (const cell of clusterCells) {
    clusterBounds.expandByPoint(cell.worldBounds.min);
    clusterBounds.expandByPoint(cell.worldBounds.max);
    const weight = Math.max(1, cell.splatCount);
    weightedCenter.addScaledVector(cell.worldCenter, weight);
    totalWeight += weight;
    avgColorDistance += colorDistance3(cell.avgColor, seedColor);
  }

  if (totalWeight > 0) {
    weightedCenter.multiplyScalar(1 / totalWeight);
  }
  avgColorDistance /= Math.max(1, clusterCells.length);

  const size = new THREE.Vector3();
  clusterBounds.getSize(size);
  const halfX = Math.max(0.05, size.x * 0.5 * config.boxPadding);
  const halfY = Math.max(0.05, size.y * 0.5 * config.boxPadding);
  const halfZ = Math.max(0.05, size.z * 0.5 * config.boxPadding);

  const suggestedShape: SDFShapeConfig = {
    type: "BOX",
    position: [weightedCenter.x, weightedCenter.y, weightedCenter.z],
    scale: [halfX, halfY, halfZ],
  };

  const confidence = clamp(
    1 - avgColorDistance / Math.max(1e-4, config.colorDistanceThreshold),
    0,
    1
  );

  const result: SelectionResult = {
    seedCellKey: seedKey,
    clusterCellKeys: Array.from(accepted.keys()),
    clusterBounds,
    clusterCenter: weightedCenter,
    suggestedShape,
    confidence,
    diagnostics: {
      visitedCells: visited.size,
      rejectedCells,
      reason: reasons,
    },
  };

  console.log(
    `[selection] Built cluster seed=${seedKey} accepted=${result.clusterCellKeys.length} visited=${visited.size} rejected=${rejectedCells} confidence=${confidence.toFixed(3)}`
  );
  return result;
}

export function formatSelectionHint(result: SelectionResult): string {
  const size = new THREE.Vector3();
  result.clusterBounds.getSize(size);
  const scale = result.suggestedShape.scale ?? [0, 0, 0];

  return [
    "Selection hints (deterministic click-seeded cluster):",
    `- seedCell=${result.seedCellKey}`,
    `- clusterCells=${result.clusterCellKeys.length} confidence=${result.confidence.toFixed(3)}`,
    `- clusterCenter=[${result.clusterCenter.x.toFixed(3)}, ${result.clusterCenter.y.toFixed(3)}, ${result.clusterCenter.z.toFixed(3)}]`,
    `- clusterSize=[${size.x.toFixed(3)}, ${size.y.toFixed(3)}, ${size.z.toFixed(3)}]`,
    `- recommendedShape=BOX scale=[${scale[0].toFixed(3)}, ${scale[1].toFixed(3)}, ${scale[2].toFixed(3)}]`,
    `- diagnostics visited=${result.diagnostics.visitedCells} rejected=${result.diagnostics.rejectedCells} reasons=${result.diagnostics.reason.join(",") || "none"}`,
    "- Prefer this local cluster unless user explicitly requests a larger region.",
  ].join("\n");
}

function getFaceNeighbors(grid: SpatialGrid, cell: VoxelCell): VoxelCell[] {
  const [x, y, z] = cell.gridPos;
  const [rx, ry, rz] = grid.resolution;
  const neighbors: VoxelCell[] = [];
  const candidates: Array<[number, number, number]> = [
    [x - 1, y, z],
    [x + 1, y, z],
    [x, y - 1, z],
    [x, y + 1, z],
    [x, y, z - 1],
    [x, y, z + 1],
  ];

  for (const [nx, ny, nz] of candidates) {
    if (nx < 0 || ny < 0 || nz < 0 || nx >= rx || ny >= ry || nz >= rz) {
      continue;
    }
    const neighbor = grid.cells.get(gridKey(nx, ny, nz));
    if (neighbor) {
      neighbors.push(neighbor);
    }
  }
  return neighbors;
}

function colorDistance3(a: THREE.Color, b: THREE.Color): number {
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
