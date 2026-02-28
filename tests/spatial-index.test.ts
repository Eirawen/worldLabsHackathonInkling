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
  transformBoundsToWorld,
  worldPosToGridCoord,
} from "../src/spatial-index";

// ---------------------------------------------------------------------------
// computeCroppedBounds
// ---------------------------------------------------------------------------

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

  it("falls back when crop fractions consume entire height", () => {
    const raw = new THREE.Box3(
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(10, 1, 10)
    );

    const result = computeCroppedBounds(raw, [0.6, 0.6]);

    expect(result.usedFallback).toBe(true);
  });

  it("does not modify X and Z axes", () => {
    const raw = new THREE.Box3(
      new THREE.Vector3(-5, 0, -3),
      new THREE.Vector3(5, 20, 7)
    );

    const result = computeCroppedBounds(raw, [0.25, 0.25]);

    expect(result.bounds.min.x).toBe(-5);
    expect(result.bounds.max.x).toBe(5);
    expect(result.bounds.min.z).toBe(-3);
    expect(result.bounds.max.z).toBe(7);
    expect(result.bounds.min.y).toBe(5);
    expect(result.bounds.max.y).toBe(15);
  });
});

// ---------------------------------------------------------------------------
// computeNominalCellSize
// ---------------------------------------------------------------------------

describe("computeNominalCellSize", () => {
  it("computes cell dimensions from bounds and resolution", () => {
    const bounds = new THREE.Box3(
      new THREE.Vector3(-5, -2, 1),
      new THREE.Vector3(5, 8, 21)
    );
    const size = computeNominalCellSize(bounds, [10, 5, 4]);
    expect(size.toArray()).toEqual([1, 2, 5]);
  });

  it("returns zero for zero-size axis", () => {
    const bounds = new THREE.Box3(
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(10, 0, 10)
    );
    const size = computeNominalCellSize(bounds, [5, 5, 5]);
    expect(size.y).toBe(0);
    expect(size.x).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// transformBoundsToWorld
// ---------------------------------------------------------------------------

describe("transformBoundsToWorld", () => {
  it("transforms local bounds into world-space AABB", () => {
    const local = new THREE.Box3(
      new THREE.Vector3(-1, -2, -3),
      new THREE.Vector3(4, 5, 6)
    );
    const matrixWorld = new THREE.Matrix4().compose(
      new THREE.Vector3(10, 20, 30),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI),
      new THREE.Vector3(1, 1, 1)
    );

    const world = transformBoundsToWorld(local, matrixWorld);
    expect(world.min.toArray()).toEqual([9, 15, 24]);
    expect(world.max.toArray()).toEqual([14, 22, 33]);
  });
});

// ---------------------------------------------------------------------------
// worldPosToGridCoord
// ---------------------------------------------------------------------------

describe("worldPosToGridCoord", () => {
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

  it("returns null for outside points without clamp", () => {
    expect(
      worldPosToGridCoord(new THREE.Vector3(-0.01, 5, 5), bounds, resolution)
    ).toBeNull();
    expect(
      worldPosToGridCoord(new THREE.Vector3(5, -1, 5), bounds, resolution)
    ).toBeNull();
    expect(
      worldPosToGridCoord(new THREE.Vector3(5, 5, 11), bounds, resolution)
    ).toBeNull();
  });

  it("clamps outside points to boundary cells with clamp=true", () => {
    // Below Y
    const below = worldPosToGridCoord(
      new THREE.Vector3(5, -2, 5), bounds, resolution, true
    );
    expect(below).toEqual([5, 0, 5]);

    // Above max
    const above = worldPosToGridCoord(
      new THREE.Vector3(12, 5, 5), bounds, resolution, true
    );
    expect(above).toEqual([9, 5, 5]);

    // All axes outside
    const corner = worldPosToGridCoord(
      new THREE.Vector3(-1, -1, -1), bounds, resolution, true
    );
    expect(corner).toEqual([0, 0, 0]);
  });

  it("maps point near cell boundary correctly", () => {
    // Point at exactly 1.0 should be cell 1 (1.0/10 * 10 = 1)
    expect(
      worldPosToGridCoord(new THREE.Vector3(1, 1, 1), bounds, resolution)
    ).toEqual([1, 1, 1]);
    // Point at 0.99 should still be cell 0
    expect(
      worldPosToGridCoord(new THREE.Vector3(0.99, 0.99, 0.99), bounds, resolution)
    ).toEqual([0, 0, 0]);
  });
});

// ---------------------------------------------------------------------------
// gridKey
// ---------------------------------------------------------------------------

describe("gridKey", () => {
  it("produces comma-separated string", () => {
    expect(gridKey(1, 2, 3)).toBe("1,2,3");
    expect(gridKey(0, 0, 0)).toBe("0,0,0");
    expect(gridKey(19, 19, 19)).toBe("19,19,19");
  });
});

// ---------------------------------------------------------------------------
// getCellAtWorldPos (with clamping / neighbor search)
// ---------------------------------------------------------------------------

describe("getCellAtWorldPos", () => {
  it("returns exact cell for interior point", () => {
    const grid = makeTestGrid();
    const hit = getCellAtWorldPos(grid, new THREE.Vector3(1.2, 1.2, 1.2));
    expect(hit).not.toBeNull();
    expect(hit?.gridPos).toEqual([0, 0, 0]);
  });

  it("returns nearest cell when point is outside grid bounds", () => {
    const grid = makeTestGrid();
    // Point below the grid at Y = -1 — should clamp to Y=0 and find cell [0,0,0]
    const hit = getCellAtWorldPos(grid, new THREE.Vector3(1, -1, 1));
    expect(hit).not.toBeNull();
    expect(hit?.gridPos).toEqual([0, 0, 0]);
  });

  it("finds nearest occupied cell when clamped cell is empty", () => {
    const grid = makeTestGrid();
    // Point at grid position [2,2,2] which has no cell — should find neighbor [1,1,1]
    const hit = getCellAtWorldPos(grid, new THREE.Vector3(5, 5, 5));
    expect(hit).not.toBeNull();
    expect(hit?.gridPos).toEqual([1, 1, 1]);
  });

  it("returns null when no occupied cell is within search radius", () => {
    // Grid with a single cell far in one corner
    const grid: SpatialGrid = {
      resolution: [20, 20, 20],
      worldBounds: new THREE.Box3(
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(100, 100, 100)
      ),
      cellSize: new THREE.Vector3(5, 5, 5),
      cells: new Map([
        [gridKey(0, 0, 0), makeCell([0, 0, 0], [0, 0, 0], [5, 5, 5], 50, [0.5, 0.5, 0.5], 0.01)],
      ]),
    };
    // Click at the far opposite corner — more than 5 grid steps away
    const hit = getCellAtWorldPos(grid, new THREE.Vector3(99, 99, 99));
    expect(hit).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getNeighborCells
// ---------------------------------------------------------------------------

describe("getNeighborCells", () => {
  it("returns all occupied cells within radius 1 including self", () => {
    const grid = makeTestGrid();
    const cell = grid.cells.get(gridKey(0, 0, 0))!;
    const neighbors = getNeighborCells(grid, cell, 1);
    const keys = neighbors.map((c) => gridKey(...c.gridPos)).sort();
    expect(keys).toEqual(["0,0,0", "1,0,0", "1,1,1"]);
  });

  it("defaults radius to 1", () => {
    const grid = makeTestGrid();
    const cell = grid.cells.get(gridKey(0, 0, 0))!;
    const neighbors = getNeighborCells(grid, cell);
    const keys = neighbors.map((c) => gridKey(...c.gridPos)).sort();
    expect(keys).toEqual(["0,0,0", "1,0,0", "1,1,1"]);
  });

  it("returns only the cell itself at radius 0", () => {
    const grid = makeTestGrid();
    const cell = grid.cells.get(gridKey(1, 1, 1))!;
    const neighbors = getNeighborCells(grid, cell, 0);
    expect(neighbors).toHaveLength(1);
    expect(neighbors[0].gridPos).toEqual([1, 1, 1]);
  });

  it("returns all cells at large radius", () => {
    const grid = makeTestGrid();
    const cell = grid.cells.get(gridKey(0, 0, 0))!;
    const neighbors = getNeighborCells(grid, cell, 10);
    expect(neighbors).toHaveLength(3); // all cells in the grid
  });

  it("does not return cells outside grid resolution", () => {
    const grid = makeTestGrid();
    const cell = grid.cells.get(gridKey(0, 0, 0))!;
    // Radius 1 from corner should not crash or return out-of-bounds
    const neighbors = getNeighborCells(grid, cell, 1);
    for (const n of neighbors) {
      expect(n.gridPos[0]).toBeGreaterThanOrEqual(0);
      expect(n.gridPos[1]).toBeGreaterThanOrEqual(0);
      expect(n.gridPos[2]).toBeGreaterThanOrEqual(0);
    }
  });
});

// ---------------------------------------------------------------------------
// serializeSpatialGridForLLM
// ---------------------------------------------------------------------------

describe("serializeSpatialGridForLLM", () => {
  it("excludes splatIndices from output", () => {
    const grid = makeTestGrid();
    const json = serializeSpatialGridForLLM(grid, { minSplats: 1 });
    expect(json.includes("splatIndices")).toBe(false);
  });

  it("uses compact keys (g, c, n, col, den)", () => {
    const grid = makeTestGrid();
    const json = serializeSpatialGridForLLM(grid, { minSplats: 1 });
    const parsed = JSON.parse(json);
    const cell = parsed.cells[0];
    expect(cell).toHaveProperty("g");     // gridPos
    expect(cell).toHaveProperty("c");     // worldCenter
    expect(cell).toHaveProperty("n");     // splatCount
    expect(cell).toHaveProperty("col");   // hex color
    expect(cell).toHaveProperty("den");   // density
    expect(cell).toHaveProperty("d");     // dimensions
    expect(cell).toHaveProperty("cv");    // colorVariance
    // Should NOT have old verbose keys
    expect(cell).not.toHaveProperty("gridPos");
    expect(cell).not.toHaveProperty("worldCenter");
    expect(cell).not.toHaveProperty("splatCount");
  });

  it("outputs avgColor as hex string", () => {
    const grid = makeTestGrid();
    const json = serializeSpatialGridForLLM(grid, { minSplats: 1 });
    const parsed = JSON.parse(json);
    for (const cell of parsed.cells) {
      expect(cell.col).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("rounds worldCenter values to 2 decimal places", () => {
    const grid = makeTestGrid();
    const json = serializeSpatialGridForLLM(grid, { minSplats: 1 });
    const parsed = JSON.parse(json);
    for (const cell of parsed.cells) {
      for (const v of cell.c) {
        const decimals = v.toString().split(".")[1]?.length ?? 0;
        expect(decimals).toBeLessThanOrEqual(2);
      }
    }
  });

  it("filters cells below minSplats threshold", () => {
    const grid = makeTestGrid(); // cells with 50, 20, 15 splats
    const json = serializeSpatialGridForLLM(grid, { minSplats: 25 });
    const parsed = JSON.parse(json);
    expect(parsed.cells).toHaveLength(1);
    expect(parsed.cells[0].n).toBe(50);
  });

  it("defaults minSplats to 10", () => {
    const grid = makeTestGrid(); // cells with 50, 20, 15 splats — all >= 10
    const json = serializeSpatialGridForLLM(grid);
    const parsed = JSON.parse(json);
    expect(parsed.cells).toHaveLength(3);
  });

  it("respects maxCells cap and keeps highest splat-count cells", () => {
    const grid = makeTestGrid();
    const json = serializeSpatialGridForLLM(grid, { maxCells: 2, minSplats: 1 });
    const parsed = JSON.parse(json);
    expect(parsed.cells).toHaveLength(2);
    // Should keep the two largest cells (50 and 20)
    const counts = parsed.cells.map((c: { n: number }) => c.n).sort((a: number, b: number) => b - a);
    expect(counts).toEqual([50, 20]);
  });

  it("includes grid metadata", () => {
    const grid = makeTestGrid();
    const json = serializeSpatialGridForLLM(grid, { minSplats: 1 });
    const parsed = JSON.parse(json);
    expect(parsed.resolution).toEqual([5, 5, 5]);
    expect(parsed.worldBounds).toHaveProperty("min");
    expect(parsed.worldBounds).toHaveProperty("max");
    expect(parsed.cellSize).toHaveLength(3);
  });

  it("includes cell dimensions", () => {
    const grid = makeTestGrid();
    const json = serializeSpatialGridForLLM(grid, { minSplats: 1 });
    const parsed = JSON.parse(json);
    for (const cell of parsed.cells) {
      expect(cell.d).toHaveLength(3);
      for (const v of cell.d) {
        expect(typeof v).toBe("number");
        expect(v).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTestGrid(): SpatialGrid {
  const worldBounds = new THREE.Box3(
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(10, 10, 10)
  );

  const cells = new Map<string, VoxelCell>();
  const cellA = makeCell([0, 0, 0], [1, 1, 1], [1.5, 1.5, 1.5], 50, [0.8, 0.2, 0.1], 0.02);
  const cellB = makeCell([1, 0, 0], [3, 1, 1], [3.5, 1.5, 1.5], 20, [0.2, 0.8, 0.2], 0.01);
  const cellC = makeCell([1, 1, 1], [3, 3, 3], [3.5, 3.5, 3.5], 15, [0.2, 0.2, 0.8], 0.005);

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
    splatIndices: Array.from({ length: splatCount }, (_, i) => i),
  };
}
