import * as THREE from "three";
import type { SceneManifest, SemanticRegion, SpatialGrid, VoxelCell } from "./types";
import { gridKey } from "./spatial-index";

const MIN_SPLATS_FOR_LABEL = 10;

type CellLabel = {
  label: string;
  confidence: number;
};

export function generateManifest(grid: SpatialGrid): SceneManifest {
  const start = typeof performance !== "undefined" ? performance.now() : Date.now();

  const cellLabels = new Map<string, CellLabel>();
  const gridSize = new THREE.Vector3();
  grid.worldBounds.getSize(gridSize);
  const yRange = { min: grid.worldBounds.min.y, max: grid.worldBounds.max.y, height: gridSize.y };

  for (const [key, cell] of grid.cells) {
    if (cell.splatCount < MIN_SPLATS_FOR_LABEL) continue;
    const label = classifyCell(cell, yRange);
    cellLabels.set(key, label);
  }

  const regions = buildRegions(grid, cellLabels);

  const description = generateDescription(regions, grid.cells.size);

  const elapsed = (typeof performance !== "undefined" ? performance.now() : Date.now()) - start;
  console.log(
    `[manifest] Generated manifest: ${regions.length} regions, ${cellLabels.size} labeled cells, ${elapsed.toFixed(1)}ms`
  );

  return {
    description,
    regions,
    grid,
    screenshots: [],
  };
}

export function getManifestJSON(manifest: SceneManifest): string {
  const r2 = (n: number) => Math.round(n * 100) / 100;

  const payload = {
    description: manifest.description,
    regionCount: manifest.regions.length,
    regions: manifest.regions.map((region) => ({
      label: region.label,
      cellCount: region.gridCells.length,
      bounds: {
        min: region.estimatedBounds.min.toArray().map(r2),
        max: region.estimatedBounds.max.toArray().map(r2),
      },
      color: "#" + region.dominantColor.getHexString(),
      confidence: r2(region.confidence),
    })),
    gridSummary: {
      resolution: manifest.grid.resolution,
      occupiedCells: manifest.grid.cells.size,
      worldBounds: {
        min: manifest.grid.worldBounds.min.toArray().map(r2),
        max: manifest.grid.worldBounds.max.toArray().map(r2),
      },
    },
  };

  return JSON.stringify(payload);
}

function classifyCell(
  cell: VoxelCell,
  yRange: { min: number; max: number; height: number }
): CellLabel {
  const { r, g, b } = cell.avgColor;
  const hsl = { h: 0, s: 0, l: 0 };
  cell.avgColor.getHSL(hsl);
  const hue = hsl.h * 360;
  const sat = hsl.s;
  const lum = hsl.l;

  const normalizedY = yRange.height > 0
    ? (cell.worldCenter.y - yRange.min) / yRange.height
    : 0.5;

  const isLow = normalizedY < 0.25;
  const isMid = normalizedY >= 0.25 && normalizedY < 0.7;
  const isHigh = normalizedY >= 0.7;

  const isVertical = cell.worldBounds.max.y - cell.worldBounds.min.y > yRange.height * 0.04;

  // Blue at high Y → sky
  if (isHigh && hue >= 180 && hue <= 260 && sat > 0.15) {
    return { label: "sky", confidence: 0.7 };
  }

  // Green at mid height → vegetation
  if (hue >= 80 && hue <= 160 && sat > 0.1 && isMid) {
    return { label: "vegetation", confidence: 0.6 };
  }

  // Green at low height → grass / ground vegetation
  if (hue >= 80 && hue <= 160 && sat > 0.1 && isLow) {
    return { label: "ground_vegetation", confidence: 0.5 };
  }

  // Very dark → shadow / dark area
  if (lum < 0.12) {
    return { label: "shadow", confidence: 0.4 };
  }

  // High color variance + vertical extent → structure / building
  if (cell.colorVariance > 0.02 && isVertical) {
    return { label: "structure", confidence: 0.5 };
  }

  // Grey/neutral, low saturation at ground level → road / pavement
  if (isLow && sat < 0.15 && lum > 0.15 && lum < 0.65) {
    return { label: "ground", confidence: 0.5 };
  }

  // Brown/tan at ground level → dirt / ground
  if (isLow && hue >= 20 && hue <= 50 && sat > 0.1 && lum < 0.6) {
    return { label: "ground", confidence: 0.45 };
  }

  // Grey/neutral, low saturation at mid-high → wall / structure
  if (!isLow && sat < 0.12 && lum > 0.2 && lum < 0.7) {
    return { label: "structure", confidence: 0.35 };
  }

  // Warm colors (red/orange/yellow) → warm surface / material
  if (hue >= 0 && hue <= 60 && sat > 0.15 && lum > 0.15) {
    return { label: "warm_surface", confidence: 0.3 };
  }

  // Bright / high luminance at top → light source / bright area
  if (isHigh && lum > 0.7) {
    return { label: "bright_area", confidence: 0.35 };
  }

  return { label: "surface", confidence: 0.2 };
}

function buildRegions(
  grid: SpatialGrid,
  cellLabels: Map<string, CellLabel>
): SemanticRegion[] {
  const visited = new Set<string>();
  const regions: SemanticRegion[] = [];

  for (const [key, labelInfo] of cellLabels) {
    if (visited.has(key)) continue;

    const component = floodFill(grid, cellLabels, key, labelInfo.label, visited);
    if (component.length === 0) continue;

    const bounds = new THREE.Box3();
    const colorSum = new THREE.Vector3();
    let totalSplats = 0;
    let confidenceSum = 0;

    for (const cellKey of component) {
      const cell = grid.cells.get(cellKey);
      if (!cell) continue;
      bounds.expandByPoint(cell.worldBounds.min);
      bounds.expandByPoint(cell.worldBounds.max);
      colorSum.x += cell.avgColor.r * cell.splatCount;
      colorSum.y += cell.avgColor.g * cell.splatCount;
      colorSum.z += cell.avgColor.b * cell.splatCount;
      totalSplats += cell.splatCount;
      const cl = cellLabels.get(cellKey);
      if (cl) confidenceSum += cl.confidence;
    }

    const invTotal = totalSplats > 0 ? 1 / totalSplats : 0;
    const dominantColor = new THREE.Color(
      colorSum.x * invTotal,
      colorSum.y * invTotal,
      colorSum.z * invTotal
    );

    regions.push({
      label: labelInfo.label,
      gridCells: component,
      estimatedBounds: bounds,
      dominantColor,
      confidence: component.length > 0 ? confidenceSum / component.length : 0,
    });
  }

  // Sort by splat count (largest regions first)
  regions.sort((a, b) => {
    const aSplats = a.gridCells.reduce(
      (sum, key) => sum + (grid.cells.get(key)?.splatCount ?? 0), 0
    );
    const bSplats = b.gridCells.reduce(
      (sum, key) => sum + (grid.cells.get(key)?.splatCount ?? 0), 0
    );
    return bSplats - aSplats;
  });

  return regions;
}

function floodFill(
  grid: SpatialGrid,
  cellLabels: Map<string, CellLabel>,
  startKey: string,
  targetLabel: string,
  visited: Set<string>
): string[] {
  const component: string[] = [];
  const queue: string[] = [startKey];

  while (queue.length > 0) {
    const key = queue.pop()!;
    if (visited.has(key)) continue;

    const labelInfo = cellLabels.get(key);
    if (!labelInfo || labelInfo.label !== targetLabel) continue;

    visited.add(key);
    component.push(key);

    const cell = grid.cells.get(key);
    if (!cell) continue;

    const [cx, cy, cz] = cell.gridPos;
    const [rx, ry, rz] = grid.resolution;

    // 6-connected neighbors (face-adjacent)
    const neighbors: [number, number, number][] = [
      [cx - 1, cy, cz], [cx + 1, cy, cz],
      [cx, cy - 1, cz], [cx, cy + 1, cz],
      [cx, cy, cz - 1], [cx, cy, cz + 1],
    ];

    for (const [nx, ny, nz] of neighbors) {
      if (nx < 0 || ny < 0 || nz < 0 || nx >= rx || ny >= ry || nz >= rz) continue;
      const nKey = gridKey(nx, ny, nz);
      if (!visited.has(nKey) && cellLabels.has(nKey)) {
        queue.push(nKey);
      }
    }
  }

  return component;
}

function generateDescription(regions: SemanticRegion[], totalCells: number): string {
  if (regions.length === 0) {
    return `The scene contains ${totalCells} occupied spatial cells with no clearly identifiable regions.`;
  }

  const counts: Record<string, number> = {};
  for (const region of regions) {
    const readable = readableLabel(region.label);
    counts[readable] = (counts[readable] ?? 0) + 1;
  }

  const parts: string[] = [];
  for (const [label, count] of Object.entries(counts)) {
    if (count === 1) {
      parts.push(`a ${label} area`);
    } else {
      parts.push(`${count} ${label} areas`);
    }
  }

  const joined = parts.length <= 2
    ? parts.join(" and ")
    : parts.slice(0, -1).join(", ") + ", and " + parts[parts.length - 1];

  return `The scene contains approximately ${joined} across ${totalCells} occupied spatial cells.`;
}

function readableLabel(label: string): string {
  const labels: Record<string, string> = {
    sky: "sky",
    vegetation: "vegetation",
    ground_vegetation: "ground vegetation",
    ground: "ground/pavement",
    structure: "structure/building",
    shadow: "shadow",
    warm_surface: "warm surface",
    bright_area: "bright",
    surface: "surface",
  };
  return labels[label] ?? label;
}
