import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { buildLocalSelection, formatSelectionHint } from "../src/click-selection";
import type { SpatialGrid, VoxelCell } from "../src/types";

describe("click-selection", () => {
  it("returns null when click has no occupied seed cell", () => {
    const grid = makeGrid([10, 10, 10], []);
    const result = buildLocalSelection(grid, new THREE.Vector3(0, 0, 0));
    expect(result).toBeNull();
  });

  it("grows a local cluster from seed using color-distance gating", () => {
    const cells = [
      makeCell([1, 1, 1], [1, 1, 1], [0.4, 0.3, 0.2], 80),
      makeCell([2, 1, 1], [2, 1, 1], [0.41, 0.29, 0.21], 70),
      makeCell([3, 1, 1], [3, 1, 1], [0.9, 0.9, 0.9], 70),
    ];
    const grid = makeGrid([6, 6, 6], cells);

    const result = buildLocalSelection(grid, new THREE.Vector3(1.05, 1.02, 1.01), {
      colorDistanceThreshold: 0.05,
      maxDepth: 3,
    });

    expect(result).not.toBeNull();
    expect(result?.clusterCellKeys).toContain("1,1,1");
    expect(result?.clusterCellKeys).toContain("2,1,1");
    expect(result?.clusterCellKeys).not.toContain("3,1,1");
    expect(result?.suggestedShape.type).toBe("BOX");
    expect(result?.confidence).toBeGreaterThan(0);
  });

  it("formats a selection hint with box recommendation", () => {
    const cells = [
      makeCell([4, 4, 4], [4, 4, 4], [0.5, 0.4, 0.3], 50),
      makeCell([5, 4, 4], [5, 4, 4], [0.52, 0.42, 0.28], 50),
    ];
    const grid = makeGrid([10, 10, 10], cells);
    const result = buildLocalSelection(grid, new THREE.Vector3(4.0, 4.0, 4.0), {
      colorDistanceThreshold: 0.08,
      maxDepth: 2,
    });

    expect(result).not.toBeNull();
    const hint = formatSelectionHint(result!);
    expect(hint).toContain("Selection hints");
    expect(hint).toContain("recommendedShape=BOX");
  });
});

function makeGrid(
  resolution: [number, number, number],
  cells: VoxelCell[]
): SpatialGrid {
  const map = new Map<string, VoxelCell>();
  for (const cell of cells) {
    map.set(cell.gridPos.join(","), cell);
  }
  return {
    resolution,
    worldBounds: new THREE.Box3(
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(10, 10, 10)
    ),
    cellSize: new THREE.Vector3(1, 1, 1),
    cells: map,
  };
}

function makeCell(
  gridPos: [number, number, number],
  center: [number, number, number],
  color: [number, number, number],
  splatCount: number
): VoxelCell {
  const worldCenter = new THREE.Vector3(center[0], center[1], center[2]);
  const worldBounds = new THREE.Box3(
    new THREE.Vector3(center[0] - 0.5, center[1] - 0.5, center[2] - 0.5),
    new THREE.Vector3(center[0] + 0.5, center[1] + 0.5, center[2] + 0.5)
  );
  return {
    gridPos,
    worldCenter,
    worldBounds,
    splatCount,
    avgColor: new THREE.Color(color[0], color[1], color[2]),
    colorVariance: 0.02,
    density: 10,
    splatIndices: [],
  };
}
