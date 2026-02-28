import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { generateManifest, getManifestJSON } from "../src/scene-manifest";
import { gridKey } from "../src/spatial-index";
import type { SpatialGrid, VoxelCell } from "../src/types";

// ---------------------------------------------------------------------------
// generateManifest
// ---------------------------------------------------------------------------

describe("generateManifest", () => {
  it("returns a manifest with description, regions, and grid reference", () => {
    const grid = makeSceneGrid();
    const manifest = generateManifest(grid);

    expect(manifest.description).toBeTruthy();
    expect(manifest.regions).toBeInstanceOf(Array);
    expect(manifest.grid).toBe(grid);
    expect(manifest.screenshots).toEqual([]);
  });

  it("produces a non-empty description", () => {
    const grid = makeSceneGrid();
    const manifest = generateManifest(grid);
    expect(manifest.description.length).toBeGreaterThan(10);
    expect(manifest.description).toContain("scene contains");
  });

  it("identifies green mid-height cells as vegetation", () => {
    const grid = makeGridWithSingleCell(
      [10, 10, 10],     // gridPos mid-range
      [0.15, 0.6, 0.1], // green color
      0.5                // normalized Y = mid
    );
    const manifest = generateManifest(grid);
    const labels = manifest.regions.map((r) => r.label);
    expect(labels).toContain("vegetation");
  });

  it("identifies grey low cells as ground", () => {
    const grid = makeGridWithSingleCell(
      [10, 1, 10],      // low Y gridPos
      [0.4, 0.4, 0.4],  // grey
      0.1                // low normalizedY
    );
    const manifest = generateManifest(grid);
    const labels = manifest.regions.map((r) => r.label);
    expect(labels).toContain("ground");
  });

  it("identifies dark cells as shadow", () => {
    const grid = makeGridWithSingleCell(
      [10, 10, 10],
      [0.05, 0.05, 0.05], // very dark
      0.5
    );
    const manifest = generateManifest(grid);
    const labels = manifest.regions.map((r) => r.label);
    expect(labels).toContain("shadow");
  });

  it("groups adjacent cells with same label into one region", () => {
    const grid = makeGrid_adjacentGreenCells();
    const manifest = generateManifest(grid);
    const vegRegions = manifest.regions.filter((r) => r.label === "vegetation");
    // Two adjacent green cells should be one region, not two
    expect(vegRegions).toHaveLength(1);
    expect(vegRegions[0].gridCells).toHaveLength(2);
  });

  it("separates non-adjacent cells with same label into different regions", () => {
    const grid = makeGrid_separatedGreenCells();
    const manifest = generateManifest(grid);
    const vegRegions = manifest.regions.filter((r) => r.label === "vegetation");
    expect(vegRegions.length).toBeGreaterThanOrEqual(2);
  });

  it("computes region bounds that enclose all member cells", () => {
    const grid = makeGrid_adjacentGreenCells();
    const manifest = generateManifest(grid);
    const region = manifest.regions.find((r) => r.label === "vegetation")!;
    expect(region).toBeDefined();

    // Bounds should encompass both cells
    for (const key of region.gridCells) {
      const cell = grid.cells.get(key)!;
      expect(region.estimatedBounds.containsPoint(cell.worldBounds.min)).toBe(true);
      expect(region.estimatedBounds.containsPoint(cell.worldBounds.max)).toBe(true);
    }
  });

  it("assigns confidence between 0 and 1", () => {
    const grid = makeSceneGrid();
    const manifest = generateManifest(grid);
    for (const region of manifest.regions) {
      expect(region.confidence).toBeGreaterThanOrEqual(0);
      expect(region.confidence).toBeLessThanOrEqual(1);
    }
  });

  it("computes dominantColor as weighted average of member cells", () => {
    const grid = makeGrid_adjacentGreenCells();
    const manifest = generateManifest(grid);
    const region = manifest.regions.find((r) => r.label === "vegetation")!;
    // Dominant color should be green-ish
    expect(region.dominantColor.g).toBeGreaterThan(region.dominantColor.r);
    expect(region.dominantColor.g).toBeGreaterThan(region.dominantColor.b);
  });

  it("skips cells with fewer than 10 splats", () => {
    const grid: SpatialGrid = {
      resolution: [20, 20, 20],
      worldBounds: new THREE.Box3(
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(20, 20, 20)
      ),
      cellSize: new THREE.Vector3(1, 1, 1),
      cells: new Map([
        [gridKey(10, 10, 10), makeCell(
          [10, 10, 10], [10, 10, 10], [11, 11, 11],
          5, // fewer than 10
          [0.15, 0.6, 0.1], 0.01
        )],
      ]),
    };
    const manifest = generateManifest(grid);
    expect(manifest.regions).toHaveLength(0);
  });

  it("handles empty grid gracefully", () => {
    const grid: SpatialGrid = {
      resolution: [20, 20, 20],
      worldBounds: new THREE.Box3(
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(20, 20, 20)
      ),
      cellSize: new THREE.Vector3(1, 1, 1),
      cells: new Map(),
    };
    const manifest = generateManifest(grid);
    expect(manifest.regions).toHaveLength(0);
    expect(manifest.description).toContain("0 occupied");
  });
});

// ---------------------------------------------------------------------------
// getManifestJSON
// ---------------------------------------------------------------------------

describe("getManifestJSON", () => {
  it("produces valid JSON", () => {
    const grid = makeSceneGrid();
    const manifest = generateManifest(grid);
    const json = getManifestJSON(manifest);
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it("includes description and regions array", () => {
    const grid = makeSceneGrid();
    const manifest = generateManifest(grid);
    const parsed = JSON.parse(getManifestJSON(manifest));
    expect(parsed).toHaveProperty("description");
    expect(parsed).toHaveProperty("regions");
    expect(parsed.regions).toBeInstanceOf(Array);
  });

  it("includes region bounds as arrays", () => {
    const grid = makeSceneGrid();
    const manifest = generateManifest(grid);
    const parsed = JSON.parse(getManifestJSON(manifest));
    for (const region of parsed.regions) {
      expect(region.bounds.min).toHaveLength(3);
      expect(region.bounds.max).toHaveLength(3);
    }
  });

  it("includes region color as hex string", () => {
    const grid = makeSceneGrid();
    const manifest = generateManifest(grid);
    const parsed = JSON.parse(getManifestJSON(manifest));
    for (const region of parsed.regions) {
      expect(region.color).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("rounds numeric values to 2 decimal places", () => {
    const grid = makeSceneGrid();
    const manifest = generateManifest(grid);
    const parsed = JSON.parse(getManifestJSON(manifest));
    for (const region of parsed.regions) {
      const decimals = region.confidence.toString().split(".")[1]?.length ?? 0;
      expect(decimals).toBeLessThanOrEqual(2);
    }
  });

  it("includes grid summary with resolution and bounds", () => {
    const grid = makeSceneGrid();
    const manifest = generateManifest(grid);
    const parsed = JSON.parse(getManifestJSON(manifest));
    expect(parsed.gridSummary).toBeDefined();
    expect(parsed.gridSummary.resolution).toEqual(grid.resolution);
    expect(parsed.gridSummary.occupiedCells).toBe(grid.cells.size);
    expect(parsed.gridSummary.worldBounds).toHaveProperty("min");
    expect(parsed.gridSummary.worldBounds).toHaveProperty("max");
  });

  it("produces output under 50KB for reasonable grids", () => {
    const grid = makeSceneGrid();
    const manifest = generateManifest(grid);
    const json = getManifestJSON(manifest);
    expect(json.length).toBeLessThan(50 * 1024);
  });
});

// ---------------------------------------------------------------------------
// Color classification edge cases
// ---------------------------------------------------------------------------

describe("color classification heuristics", () => {
  it("classifies warm colors as warm_surface", () => {
    const grid = makeGridWithSingleCell(
      [10, 10, 10],
      [0.8, 0.4, 0.1], // orange/warm
      0.5
    );
    const manifest = generateManifest(grid);
    const labels = manifest.regions.map((r) => r.label);
    expect(labels).toContain("warm_surface");
  });

  it("classifies bright high cells as bright_area", () => {
    const grid = makeGridWithSingleCell(
      [10, 16, 10],     // high Y
      [0.9, 0.9, 0.9],  // bright white
      0.8                // high normalizedY
    );
    const manifest = generateManifest(grid);
    const labels = manifest.regions.map((r) => r.label);
    expect(labels).toContain("bright_area");
  });

  it("classifies brown low cells as ground", () => {
    const grid = makeGridWithSingleCell(
      [10, 2, 10],       // low Y
      [0.5, 0.35, 0.15], // brown/tan
      0.1
    );
    const manifest = generateManifest(grid);
    const labels = manifest.regions.map((r) => r.label);
    expect(labels).toContain("ground");
  });

  it("classifies green low cells as ground_vegetation", () => {
    const grid = makeGridWithSingleCell(
      [10, 2, 10],       // low Y
      [0.15, 0.5, 0.1],  // green
      0.1
    );
    const manifest = generateManifest(grid);
    const labels = manifest.regions.map((r) => r.label);
    expect(labels).toContain("ground_vegetation");
  });
});

// ---------------------------------------------------------------------------
// Description generation
// ---------------------------------------------------------------------------

describe("description generation", () => {
  it("mentions region count in description", () => {
    const grid = makeSceneGrid();
    const manifest = generateManifest(grid);
    // Description should mention the types of regions found
    expect(manifest.description).toContain("area");
  });

  it("uses natural language with 'and' for multiple items", () => {
    const grid = makeSceneGrid();
    const manifest = generateManifest(grid);
    // A mixed scene should produce a description with "and"
    if (manifest.regions.length > 1) {
      expect(manifest.description).toContain("and");
    }
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A realistic-ish grid with a mix of cell types */
function makeSceneGrid(): SpatialGrid {
  const worldBounds = new THREE.Box3(
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(20, 20, 20)
  );

  const cells = new Map<string, VoxelCell>();

  // Green vegetation at mid height
  cells.set(gridKey(5, 10, 5), makeCell(
    [5, 10, 5], [5, 10, 5], [6, 11, 6], 100, [0.15, 0.55, 0.1], 0.01
  ));
  cells.set(gridKey(5, 11, 5), makeCell(
    [5, 11, 5], [5, 11, 5], [6, 12, 6], 80, [0.12, 0.5, 0.08], 0.015
  ));

  // Grey ground
  cells.set(gridKey(10, 2, 10), makeCell(
    [10, 2, 10], [10, 2, 10], [11, 3, 11], 200, [0.4, 0.4, 0.4], 0.005
  ));

  // Dark shadow
  cells.set(gridKey(15, 5, 15), makeCell(
    [15, 5, 15], [15, 5, 15], [16, 6, 16], 50, [0.05, 0.05, 0.05], 0.001
  ));

  // Warm surface
  cells.set(gridKey(8, 8, 8), makeCell(
    [8, 8, 8], [8, 8, 8], [9, 9, 9], 120, [0.7, 0.35, 0.1], 0.02
  ));

  return {
    resolution: [20, 20, 20],
    worldBounds,
    cellSize: new THREE.Vector3(1, 1, 1),
    cells,
  };
}

/** Grid with a single cell at controlled position/color for testing classification */
function makeGridWithSingleCell(
  gridPos: [number, number, number],
  color: [number, number, number],
  normalizedY: number
): SpatialGrid {
  const worldBounds = new THREE.Box3(
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(20, 20, 20)
  );

  const yWorld = normalizedY * 20;
  const cells = new Map<string, VoxelCell>();
  cells.set(gridKey(...gridPos), makeCell(
    gridPos,
    [gridPos[0], yWorld, gridPos[2]],
    [gridPos[0] + 1, yWorld + 1, gridPos[2] + 1],
    50,
    color,
    0.01
  ));

  return {
    resolution: [20, 20, 20],
    worldBounds,
    cellSize: new THREE.Vector3(1, 1, 1),
    cells,
  };
}

/** Two adjacent green cells that should merge into one vegetation region */
function makeGrid_adjacentGreenCells(): SpatialGrid {
  const worldBounds = new THREE.Box3(
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(20, 20, 20)
  );

  const cells = new Map<string, VoxelCell>();
  cells.set(gridKey(10, 10, 10), makeCell(
    [10, 10, 10], [10, 10, 10], [11, 11, 11], 60, [0.15, 0.55, 0.1], 0.01
  ));
  cells.set(gridKey(10, 11, 10), makeCell(
    [10, 11, 10], [10, 11, 10], [11, 12, 11], 40, [0.12, 0.5, 0.08], 0.015
  ));

  return {
    resolution: [20, 20, 20],
    worldBounds,
    cellSize: new THREE.Vector3(1, 1, 1),
    cells,
  };
}

/** Two green cells far apart that should NOT merge */
function makeGrid_separatedGreenCells(): SpatialGrid {
  const worldBounds = new THREE.Box3(
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(20, 20, 20)
  );

  const cells = new Map<string, VoxelCell>();
  cells.set(gridKey(2, 10, 2), makeCell(
    [2, 10, 2], [2, 10, 2], [3, 11, 3], 50, [0.15, 0.55, 0.1], 0.01
  ));
  cells.set(gridKey(18, 10, 18), makeCell(
    [18, 10, 18], [18, 10, 18], [19, 11, 19], 50, [0.12, 0.5, 0.08], 0.015
  ));

  return {
    resolution: [20, 20, 20],
    worldBounds,
    cellSize: new THREE.Vector3(1, 1, 1),
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
  const center = new THREE.Vector3()
    .addVectors(bounds.min, bounds.max)
    .multiplyScalar(0.5);

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
