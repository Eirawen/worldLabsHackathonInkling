import * as THREE from "three";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SplatMesh } from "@sparkjsdev/spark";
import type { EditOperation } from "../src/types";

type MockStoredSplat = {
  center: THREE.Vector3;
  scales: THREE.Vector3;
  quaternion: THREE.Quaternion;
  opacity: number;
  color: THREE.Color;
};

const { MockPackedSplats, MockSplatMesh } = vi.hoisted(() => {
  class PackedSplats {
    public splats: MockStoredSplat[] = [];
    public needsUpdate = false;

    pushSplat(
      center: THREE.Vector3,
      scales: THREE.Vector3,
      quaternion: THREE.Quaternion,
      opacity: number,
      color: THREE.Color
    ) {
      this.splats.push({
        center: center.clone(),
        scales: scales.clone(),
        quaternion: quaternion.clone(),
        opacity,
        color: color.clone(),
      });
    }
  }

  class SplatMesh {
    public packedSplats?: PackedSplats;
    public maxSh = 3;
    public position = new THREE.Vector3();
    public quaternion = new THREE.Quaternion();

    constructor(options?: { packedSplats?: PackedSplats }) {
      this.packedSplats = options?.packedSplats;
    }
  }

  return {
    MockPackedSplats: PackedSplats,
    MockSplatMesh: SplatMesh,
  };
});

vi.mock("@sparkjsdev/spark", () => ({
  PackedSplats: MockPackedSplats,
  SplatMesh: MockSplatMesh,
}));

beforeEach(() => {
  vi.resetModules();
});

describe("asset-library extraction", () => {
  it("extracts sphere-contained splats deterministically", async () => {
    const { extractAssetFromDeleteOperation } = await import("../src/asset-library");

    const op = deleteOp({ type: "SPHERE", position: [0, 0, 0], radius: 1.0 });
    const mesh = makeMesh([
      ...repeatPoint(new THREE.Vector3(0.2, 0.1, 0.1), 30),
      ...repeatPoint(new THREE.Vector3(3, 0, 0), 12),
    ]);

    const entry = extractAssetFromDeleteOperation(op, mesh, "scene-a");

    expect(entry).not.toBeNull();
    expect(entry?.splatCount).toBe(30);
    expect(entry?.label).toBe("pillow");
  });

  it("supports ellipsoid and box inclusion for extraction", async () => {
    const { extractAssetFromDeleteOperation } = await import("../src/asset-library");

    const ellipsoidOp = deleteOp({
      type: "ELLIPSOID",
      position: [0, 0, 0],
      scale: [2, 1, 1],
    });

    const ellipsoidMesh = makeMesh([
      ...repeatPoint(new THREE.Vector3(1.5, 0, 0), 26),
      ...repeatPoint(new THREE.Vector3(2.5, 0, 0), 8),
    ]);

    const ellipsoidEntry = extractAssetFromDeleteOperation(ellipsoidOp, ellipsoidMesh, "scene-b");
    expect(ellipsoidEntry?.splatCount).toBe(26);

    const boxOp = deleteOp({
      type: "BOX",
      position: [0, 0, 0],
      scale: [1, 1, 1],
    });

    const boxMesh = makeMesh([
      ...repeatPoint(new THREE.Vector3(0.9, 0.2, 0.2), 27),
      ...repeatPoint(new THREE.Vector3(1.6, 0, 0), 6),
    ]);

    const boxEntry = extractAssetFromDeleteOperation(boxOp, boxMesh, "scene-b");
    expect(boxEntry?.splatCount).toBe(27);
  });

  it("supports cylinder and capsule extraction shapes", async () => {
    const { extractAssetFromDeleteOperation } = await import("../src/asset-library");

    const cylinderOp = deleteOp({
      type: "CYLINDER",
      position: [0, 0, 0],
      scale: [1, 1, 1],
    });

    const cylinderMesh = makeMesh([
      ...repeatPoint(new THREE.Vector3(0.6, 0.8, 0.4), 20),
      ...repeatPoint(new THREE.Vector3(1.6, 0, 0), 6),
    ]);
    const cylinderEntry = extractAssetFromDeleteOperation(cylinderOp, cylinderMesh, "scene-b");
    expect(cylinderEntry?.splatCount).toBe(20);

    const capsuleOp = deleteOp({
      type: "CAPSULE",
      position: [0, 0, 0],
      scale: [0.9, 1.4, 0.9],
    });
    const capsuleMesh = makeMesh([
      ...repeatPoint(new THREE.Vector3(0.2, 1.1, 0.1), 18),
      ...repeatPoint(new THREE.Vector3(1.6, 1.6, 0), 6),
    ]);
    const capsuleEntry = extractAssetFromDeleteOperation(capsuleOp, capsuleMesh, "scene-b");
    expect(capsuleEntry?.splatCount).toBe(18);
  });

  it("creates synthetic fallback asset when region capture is empty", async () => {
    const { extractAssetFromDeleteOperation } = await import("../src/asset-library");

    const op = deleteOp({
      type: "BOX",
      position: [100, 100, 100],
      scale: [0.1, 0.1, 0.1],
    });
    const mesh = makeMesh(repeatPoint(new THREE.Vector3(0, 0, 0), 12));

    const entry = extractAssetFromDeleteOperation(op, mesh, "scene-synth");
    expect(entry).not.toBeNull();
    expect(entry?.splatCount).toBeGreaterThan(0);
  });

  it("uses proximity fallback before synthetic when strict region misses", async () => {
    const { extractAssetFromDeleteOperation } = await import("../src/asset-library");

    const op = deleteOp({
      type: "SPHERE",
      position: [0, 0, 0],
      radius: 0.01,
    });
    const mesh = makeMesh([
      ...repeatPoint(new THREE.Vector3(0.25, 0, 0), 14),
      ...repeatPoint(new THREE.Vector3(2.5, 2.5, 2.5), 6),
    ]);

    const entry = extractAssetFromDeleteOperation(op, mesh, "scene-prox");
    expect(entry).not.toBeNull();
    expect(entry?.splatCount).toBeGreaterThan(1);
  });

  it("normalizes extracted positions around centroid and keeps world bounds", async () => {
    const { extractAssetFromDeleteOperation } = await import("../src/asset-library");

    const op = deleteOp({ type: "BOX", position: [11, 0, 0], scale: [2, 2, 2] });
    const mesh = makeMesh([
      ...repeatPoint(new THREE.Vector3(10, 0, 0), 20),
      ...repeatPoint(new THREE.Vector3(12, 0, 0), 20),
    ]);

    const entry = extractAssetFromDeleteOperation(op, mesh, "scene-c");
    expect(entry).not.toBeNull();
    expect(entry?.originalPosition.x).toBeCloseTo(11, 6);
    expect(entry?.bounds.min.x).toBeCloseTo(10, 6);
    expect(entry?.bounds.max.x).toBeCloseTo(12, 6);

    const stored = entry?.splats as unknown as { splats: MockStoredSplat[] };
    expect(stored.splats[0]?.center.x).toBeCloseTo(-1, 6);
    expect(stored.splats[stored.splats.length - 1]?.center.x).toBeCloseTo(1, 6);
  });
});

describe("asset-library storage and placement", () => {
  it("stores entries in memory and creates placeable meshes", async () => {
    const {
      addAsset,
      createPlacedAssetMesh,
      extractAssetFromDeleteOperation,
      getAssetById,
      listAssets,
    } = await import("../src/asset-library");

    const op = deleteOp({ type: "SPHERE", position: [0, 0, 0], radius: 1.0 });
    const mesh = makeMesh(repeatPoint(new THREE.Vector3(0, 0, 0), 30));
    const entry = extractAssetFromDeleteOperation(op, mesh, "scene-d");

    expect(entry).not.toBeNull();
    addAsset(entry!);

    const listed = listAssets();
    expect(listed).toHaveLength(1);
    expect(getAssetById(entry!.id)?.id).toBe(entry!.id);

    const placed = createPlacedAssetMesh(entry!, new THREE.Vector3(4, 2, -1));
    expect(placed.maxSh).toBe(0);
    expect(placed.position.toArray()).toEqual([4, 2, -1]);
    expect(placed.quaternion.toArray()).toEqual([1, 0, 0, 0]);
  });
});

function deleteOp(shape: EditOperation["shapes"][number]): EditOperation {
  return {
    action: "delete",
    blendMode: "MULTIPLY",
    extractAsset: true,
    assetLabel: "pillow",
    shapes: [{ ...shape, opacity: 0 }],
  };
}

function repeatPoint(point: THREE.Vector3, count: number): THREE.Vector3[] {
  return Array.from({ length: count }, () => point.clone());
}

function makeMesh(points: THREE.Vector3[]): SplatMesh {
  const splats: MockStoredSplat[] = points.map((center) => ({
    center,
    scales: new THREE.Vector3(0.03, 0.03, 0.03),
    quaternion: new THREE.Quaternion(0, 0, 0, 1),
    opacity: 1,
    color: new THREE.Color(0.55, 0.5, 0.45),
  }));

  return {
    forEachSplat(callback: (index: number, center: THREE.Vector3, scales: THREE.Vector3, quaternion: THREE.Quaternion, opacity: number, color: THREE.Color) => void) {
      for (let i = 0; i < splats.length; i += 1) {
        const splat = splats[i];
        callback(i, splat.center, splat.scales, splat.quaternion, splat.opacity, splat.color);
      }
    },
  } as unknown as SplatMesh;
}
