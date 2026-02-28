import * as THREE from "three";

export type SpikeAnchors = {
  deleteCenter: THREE.Vector3;
  recolorCenter: THREE.Vector3;
  lightCenter: THREE.Vector3;
  sphereRadius: number;
  boxScale: THREE.Vector3;
  lightRadius: number;
};

export function computeSpikeAnchors(
  center: THREE.Vector3,
  size: THREE.Vector3
): SpikeAnchors {
  const hasValidBounds =
    Number.isFinite(center.x) &&
    Number.isFinite(center.y) &&
    Number.isFinite(center.z) &&
    Number.isFinite(size.x) &&
    Number.isFinite(size.y) &&
    Number.isFinite(size.z) &&
    Math.max(size.x, size.y, size.z) > 0;

  if (!hasValidBounds) {
    return {
      deleteCenter: new THREE.Vector3(0, 0, -3),
      recolorCenter: new THREE.Vector3(0.35, 0.1, -3),
      lightCenter: new THREE.Vector3(-0.35, 0.2, -3),
      sphereRadius: 0.2,
      boxScale: new THREE.Vector3(0.25, 0.25, 0.25),
      lightRadius: 0.3,
    };
  }

  const maxExtent = Math.max(size.x, size.y, size.z);
  const radius = THREE.MathUtils.clamp(maxExtent * 0.06, 0.08, 2.5);
  const lightRadius = THREE.MathUtils.clamp(maxExtent * 0.09, 0.12, 3.5);
  const dx = THREE.MathUtils.clamp(size.x * 0.12, radius * 1.2, radius * 3.5);
  const dy = THREE.MathUtils.clamp(size.y * 0.05, radius * 0.4, radius * 2.0);
  const dz = THREE.MathUtils.clamp(size.z * 0.12, radius * 1.2, radius * 3.5);

  const deleteCenter = center.clone().add(new THREE.Vector3(-dx, dy, -dz));
  const recolorCenter = center.clone().add(new THREE.Vector3(dx, 0, -dz * 0.4));
  const lightCenter = center.clone().add(new THREE.Vector3(0, dy + radius, dz));

  return {
    deleteCenter,
    recolorCenter,
    lightCenter,
    sphereRadius: radius,
    boxScale: new THREE.Vector3(radius * 1.4, radius * 1.0, radius * 1.2),
    lightRadius,
  };
}

export function formatPoint(point: THREE.Vector3): string {
  return `(${point.x.toFixed(3)}, ${point.y.toFixed(3)}, ${point.z.toFixed(3)})`;
}
