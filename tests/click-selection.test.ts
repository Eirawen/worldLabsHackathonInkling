import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  applyFloorProtection,
  buildLocalSelection,
  type SelectionOptions,
} from "../src/click-selection";
import { gridKey } from "../src/spatial-index";
import type { SpatialGrid, VoxelCell } from "../src/types";

describe("applyFloorProtection", () => {
  it("removes lowest quantile cells by Y center", () => {
    const cells = [
      makeCell([0, 0, 0], [0, 0.0, 0], [1, 0.2, 1], [0.4, 0.4, 0.4]),
      makeCell([0, 1, 0], [0, 1.0, 0], [1, 1.2, 1], [0.4, 0.4, 0.4]),
      makeCell([0, 2, 0], [0, 2.0, 0], [1, 2.2, 1], [0.4, 0.4, 0.4]),
      makeCell([0, 3, 0], [0, 3.0, 0], [1, 3.2, 1], [0.4, 0.4, 0.4]),
      makeCell([0, 4, 0], [0, 4.0, 0], [1, 4.2, 1], [0.4, 0.4, 0.4]),
    ];

    const result = applyFloorProtection(cells, {
      enableFloorProtection: true,
      bottomQuantileReject: 0.2,
      minProtectedCells: 2,
    });

    expect(result.applied).toBe(true);
    expect(result.floorRejectedCells).toBe(1);
    expect(result.cells).toHaveLength(4);
    expect(result.cells.every((c) => c.worldCenter.y > 0.1)).toBe(true);
  });

  it("falls back when filtered cluster is too small", () => {
    const cells = [
      makeCell([0, 0, 0], [0, 0.0, 0], [1, 0.2, 1], [0.4, 0.4, 0.4]),
      makeCell([0, 1, 0], [0, 1.0, 0], [1, 1.2, 1], [0.4, 0.4, 0.4]),
    ];

    const result = applyFloorProtection(cells, {
      enableFloorProtection: true,
      bottomQuantileReject: 0.6,
      minProtectedCells: 2,
    });

    expect(result.applied).toBe(false);
    expect(result.reason).toBe("floorProtectionFallback_smallCluster");
    expect(result.cells).toHaveLength(2);
    expect(result.floorRejectedCells).toBe(1);
  });

  it("returns unchanged cells when disabled", () => {
    const cells = [
      makeCell([0, 0, 0], [0, 0.0, 0], [1, 0.2, 1], [0.4, 0.4, 0.4]),
      makeCell([0, 1, 0], [0, 1.0, 0], [1, 1.2, 1], [0.4, 0.4, 0.4]),
    ];

    const result = applyFloorProtection(cells, {
      enableFloorProtection: false,
    });

    expect(result.applied).toBe(false);
    expect(result.reason).toBe("floorProtectionDisabled");
    expect(result.floorRejectedCells).toBe(0);
    expect(result.cells).toHaveLength(2);
  });
});

describe("buildLocalSelection floor behavior", () => {
  it("shifts ellipsoid center upward when floor protection is enabled", () => {
    const grid = makeVerticalGrid();
    const click = new THREE.Vector3(0.5, 2.1, 0.5);

    const base = buildLocalSelection(grid, click, {
      ...baseSelectionOptions(),
      enableFloorProtection: false,
      upwardCenterBiasFactor: 0,
    });
    const filtered = buildLocalSelection(grid, click, {
      ...baseSelectionOptions(),
      enableFloorProtection: true,
      bottomQuantileReject: 0.2,
      minProtectedCells: 2,
      upwardCenterBiasFactor: 0.08,
    });

    expect(base).not.toBeNull();
    expect(filtered).not.toBeNull();

    expect(filtered!.diagnostics.acceptedCellsBeforeFloorFilter).toBeGreaterThan(
      filtered!.diagnostics.acceptedCellsAfterFloorFilter
    );
    expect(filtered!.diagnostics.floorRejectedCells).toBeGreaterThan(0);
    expect(filtered!.clusterCenter.y).toBeGreaterThan(base!.clusterCenter.y);
  });

  it("keeps diagnostics populated for floor filter fields", () => {
    const grid = makeVerticalGrid();
    const click = new THREE.Vector3(0.5, 2.1, 0.5);
    const result = buildLocalSelection(grid, click, {
      ...baseSelectionOptions(),
      enableFloorProtection: true,
      bottomQuantileReject: 0.2,
      minProtectedCells: 2,
      upwardCenterBiasFactor: 0.08,
    });

    expect(result).not.toBeNull();
    expect(result!.diagnostics.acceptedCellsBeforeFloorFilter).toBeGreaterThan(0);
    expect(result!.diagnostics.acceptedCellsAfterFloorFilter).toBeGreaterThan(0);
    expect(result!.diagnostics.floorRejectedCells).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(result!.diagnostics.reason)).toBe(true);
  });
});

function baseSelectionOptions(): SelectionOptions {
  return {
    colorDistanceThreshold: 0.05,
    maxVisitedCells: 50,
    maxDepth: 5,
    maxClusterCells: 50,
    minClusterCells: 2,
    ellipsoidPadding: 1.12,
  };
}

function makeVerticalGrid(): SpatialGrid {
  const cells = new Map<string, VoxelCell>();

  for (let y = 0; y < 5; y += 1) {
    const minY = y;
    const maxY = y + 1;
    const cell = makeCell(
      [0, y, 0],
      [0, minY, 0],
      [1, maxY, 1],
      [0.55, 0.55, 0.55]
    );
    cells.set(gridKey(0, y, 0), cell);
  }

  return {
    resolution: [2, 6, 2],
    worldBounds: new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(2, 6, 2)),
    cellSize: new THREE.Vector3(1, 1, 1),
    cells,
  };
}

function makeCell(
  gridPos: [number, number, number],
  min: [number, number, number],
  max: [number, number, number],
  avgColor: [number, number, number]
): VoxelCell {
  const bounds = new THREE.Box3(new THREE.Vector3(...min), new THREE.Vector3(...max));
  const center = new THREE.Vector3().addVectors(bounds.min, bounds.max).multiplyScalar(0.5);
  return {
    gridPos,
    worldCenter: center,
    worldBounds: bounds,
    splatCount: 25,
    avgColor: new THREE.Color(...avgColor),
    colorVariance: 0.01,
    density: 10,
    splatIndices: [],
  };
}
