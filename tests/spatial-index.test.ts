import * as THREE from "three";
import { describe, expect, it } from "vitest";
import type { SpatialGrid, VoxelCell } from "../src/types";
import {
  computeCroppedBounds,
  computeNominalCellSize,
  getCellAtWorldPos,
  getNeighborCells,
  gridKey,
  serializeSpatialGridForLLM,
  worldPosToGridCoord,
} from "../src/spatial-index";

describe("computeCroppedBounds", () => {
  it("crops top and bottom Y by fractions", () => {
    const raw = new THREE.Box3(
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(10, 10, 10)
    );

    const result = computeCroppedBounds(raw, [0.1, 0.1]);

    expect(result.usedFallback).toBe(false);
    expect(result.bounds.min.y).toBe(1);
    expect(result.bounds.max.y).toBe(9);
    expect(result.bounds.min.x).toBe(0);
    expect(result.bounds.max.z).toBe(10);
  });

  it("falls back for zero-height bounds", () => {
    const raw = new THREE.Box3(
      new THREE.Vector3(0, 5, 0),
      new THREE.Vector3(10, 5, 10)
    );

    const result = computeCroppedBounds(raw, [0.1, 0.1]);

    expect(result.usedFallback).toBe(true);
    expect(result.bounds.min.y).toBe(5);
    expect(result.bounds.max.y).toBe(5);
  });
});

describe("grid coordinate mapping", () => {
  const bounds = new THREE.Box3(
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(10, 10, 10)
  );
  const resolution: [number, number, number] = [10, 10, 10];

  it("maps interior points to expected cells", () => {
    expect(
      worldPosToGridCoord(new THREE.Vector3(5, 5, 5), bounds, resolution)
    ).toEqual([5, 5, 5]);
    expect(
      worldPosToGridCoord(new THREE.Vector3(0.01, 0.01, 0.01), bounds, resolution)
    ).toEqual([0, 0, 0]);
  });

  it("clamps max boundary to last cell", () => {
    expect(
      worldPosToGridCoord(new THREE.Vector3(10, 10, 10), bounds, resolution)
    ).toEqual([9, 9, 9]);
  });

  it("returns null outside bounds", () => {
    expect(
      worldPosToGridCoord(new THREE.Vector3(-0.01, 5, 5), bounds, resolution)
    ).toBeNull();
  });
});

describe("grid queries + serialization", () => {
  it("returns correct cell and neighbors, and omits splatIndices in JSON", () => {
    const grid = makeTestGrid();
    const hit = getCellAtWorldPos(grid, new THREE.Vector3(1.2, 1.2, 1.2));
    expect(hit).not.toBeNull();
    expect(hit?.gridPos).toEqual([0, 0, 0]);

    const neighbors = getNeighborCells(grid, hit as VoxelCell, 1);
    const keys = neighbors.map((c) => gridKey(...c.gridPos)).sort();
    expect(keys).toEqual(["0,0,0", "1,0,0", "1,1,1"]);

    const json = serializeSpatialGridForLLM(grid);
    expect(json.includes("splatIndices")).toBe(false);

    const parsed = JSON.parse(json) as {
      cells: Array<{ key: string; colorVariance: number; density: number }>;
    };
    expect(parsed.cells).toHaveLength(3);
    for (const cell of parsed.cells) {
      expect(cell.colorVariance).toBeGreaterThanOrEqual(0);
      expect(cell.density).toBeGreaterThan(0);
    }
  });

  it("truncates serialized cells when maxCells is provided", () => {
    const grid = makeTestGrid();
    const json = serializeSpatialGridForLLM(grid, { maxCells: 1 });
    const parsed = JSON.parse(json) as { cells: Array<{ key: string; splatCount: number }> };
    expect(parsed.cells).toHaveLength(1);
    expect(parsed.cells[0]?.splatCount).toBe(10);
  });
});

describe("computeNominalCellSize", () => {
  it("computes cell dimensions from bounds and resolution", () => {
    const bounds = new THREE.Box3(
      new THREE.Vector3(-5, -2, 1),
      new THREE.Vector3(5, 8, 21)
    );
    const size = computeNominalCellSize(bounds, [10, 5, 4]);
    expect(size.toArray()).toEqual([1, 2, 5]);
  });
});

function makeTestGrid(): SpatialGrid {
  const worldBounds = new THREE.Box3(
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(10, 10, 10)
  );

  const cells = new Map<string, VoxelCell>();
  const cellA = makeCell([0, 0, 0], [1, 1, 1], [1.5, 1.5, 1.5], 10, [0.8, 0.2, 0.1], 0.02);
  const cellB = makeCell([1, 0, 0], [3, 1, 1], [3.5, 1.5, 1.5], 4, [0.2, 0.8, 0.2], 0.01);
  const cellC = makeCell([1, 1, 1], [3, 3, 3], [3.5, 3.5, 3.5], 2, [0.2, 0.2, 0.8], 0.005);

  cells.set(gridKey(...cellA.gridPos), cellA);
  cells.set(gridKey(...cellB.gridPos), cellB);
  cells.set(gridKey(...cellC.gridPos), cellC);

  return {
    resolution: [5, 5, 5],
    worldBounds,
    cellSize: new THREE.Vector3(2, 2, 2),
    cells,
  };
}

function makeCell(
  gridPos: [number, number, number],
  min: [number, number, number],
  max: [number, number, number],
  splatCount: number,
  avgColor: [number, number, number],
  colorVariance: number
): VoxelCell {
  const bounds = new THREE.Box3(
    new THREE.Vector3(...min),
    new THREE.Vector3(...max)
  );
  const center = new THREE.Vector3().addVectors(bounds.min, bounds.max).multiplyScalar(0.5);

  return {
    gridPos,
    worldCenter: center,
    worldBounds: bounds,
    splatCount,
    avgColor: new THREE.Color(...avgColor),
    colorVariance,
    density: splatCount / 8,
    splatIndices: [0, 1, 2],
  };
}
