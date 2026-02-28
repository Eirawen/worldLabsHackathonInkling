import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { computeSpikeAnchors, formatPoint } from "../src/spike-utils";

describe("formatPoint", () => {
  it("formats coordinates to 3 decimals", () => {
    const point = new THREE.Vector3(1.23456, -2.34567, 0.00049);
    expect(formatPoint(point)).toBe("(1.235, -2.346, 0.000)");
  });
});

describe("computeSpikeAnchors", () => {
  it("returns fallback anchors for invalid bounds", () => {
    const center = new THREE.Vector3(Number.NaN, 0, 0);
    const size = new THREE.Vector3(0, 0, 0);

    const anchors = computeSpikeAnchors(center, size);

    expect(anchors.deleteCenter.toArray()).toEqual([0, 0, -3]);
    expect(anchors.recolorCenter.toArray()).toEqual([0.35, 0.1, -3]);
    expect(anchors.lightCenter.toArray()).toEqual([-0.35, 0.2, -3]);
    expect(anchors.sphereRadius).toBe(0.2);
    expect(anchors.lightRadius).toBe(0.3);
    expect(anchors.boxScale.toArray()).toEqual([0.25, 0.25, 0.25]);
  });

  it("computes separated anchors around scene center for valid bounds", () => {
    const center = new THREE.Vector3(10, 5, -2);
    const size = new THREE.Vector3(20, 10, 8);

    const anchors = computeSpikeAnchors(center, size);

    expect(anchors.sphereRadius).toBeGreaterThan(0);
    expect(anchors.lightRadius).toBeGreaterThan(anchors.sphereRadius);

    expect(anchors.deleteCenter.x).toBeLessThan(center.x);
    expect(anchors.recolorCenter.x).toBeGreaterThan(center.x);
    expect(anchors.lightCenter.z).toBeGreaterThan(center.z);

    expect(anchors.boxScale.x).toBeCloseTo(anchors.sphereRadius * 1.4);
    expect(anchors.boxScale.y).toBeCloseTo(anchors.sphereRadius);
    expect(anchors.boxScale.z).toBeCloseTo(anchors.sphereRadius * 1.2);
  });

  it("clamps radii for extremely large scenes", () => {
    const anchors = computeSpikeAnchors(
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(1000, 800, 1200)
    );

    expect(anchors.sphereRadius).toBe(2.5);
    expect(anchors.lightRadius).toBe(3.5);
  });
});
