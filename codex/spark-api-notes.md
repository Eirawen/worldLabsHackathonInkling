# Spark API Notes — Marble Muse

## Key Classes

### SplatMesh
- High-level interface for a collection of gaussian splats
- Extends THREE.Object3D — position, quaternion, rotation all work
- Load from URL: `new SplatMesh({ url: "scene.spz" })`
- Load from bytes: `new SplatMesh({ fileBytes: arrayBuffer })`
- Load from PackedSplats: `new SplatMesh({ packedSplats: ps })`
- Wait for ready: `await splatMesh.initialized`
- Supports .ply, .spz, .splat, .ksplat

Key methods:
- `forEachSplat((index, center, scales, quaternion, opacity, color) => void)` — iterate all splats
- `pushSplat(center, scales, quaternion, opacity, color)` — add a splat
- `getBoundingBox(centers_only=true)` — get THREE.Box3
- `raycast(raycaster, intersects[])` — standard Three.js raycaster interface (WASM-based)

Key properties:
- `packedSplats` — the underlying PackedSplats data
- `recolor` — THREE.Color tint multiplier
- `opacity` — global opacity multiplier
- `editable` — whether SplatEdits affect this mesh (default true)
- `maxSh` — max spherical harmonics degree (0-3, default 3). Set to 0 for extracted assets.

### PackedSplats
- 16 bytes per splat, cache-efficient format
- Positions: float16 (3 × 2 bytes)
- Scales: uint8 log-encoded (3 × 1 byte) — range e^-12 to e^9
- RGBA: uint8 sRGB (4 × 1 byte)
- Quaternion: octahedral + angle encoding (3 bytes)

Key methods:
- `getSplat(index)` → `{ center, scales, quaternion, color, opacity }`
- `setSplat(index, center, scales, quaternion, opacity, color)`
- `pushSplat(center, scales, quaternion, opacity, color)` — append, auto-resize
- `forEachSplat(callback)` — iterate
- `needsUpdate = true` — trigger GPU re-upload after mutations

Also available via `utils`:
- `utils.setPackedSplat(packedArray, index, x, y, z, scaleX, scaleY, ...)`
- `utils.unpackSplat(packedArray, index)` → components
- `utils.setPackedSplatScales(packedArray, index, sx, sy, sz)`
- `utils.setPackedSplatQuat(packedArray, index, qx, qy, qz, qw)`

### SplatEdit
- Non-destructive, GPU-side splat modifications via SDF shapes
- Blend modes:
  - `MULTIPLY` — multiply RGBA (use opacity:0 to delete, low values to darken)
  - `SET_RGB` — override splat RGB (ignore alpha), use for recoloring
  - `ADD_RGBA` — add to RGBA (use for lighting effects)
- Parameters:
  - `sdfSmooth` — blending between multiple SDF shapes (world-space units, default 0)
  - `softEdge` — falloff radius at shape boundaries (world-space units, default 0)
  - `invert` — swap inside/outside
- Can be scoped to specific SplatMesh (add as child) or global (add to scene)

### SplatEditSdf
- Individual SDF shape within a SplatEdit
- Extends THREE.Object3D — position, quaternion, scale all work
- Types: ALL, PLANE, SPHERE, BOX, ELLIPSOID, CYLINDER, CAPSULE, INFINITE_CONE
- Properties:
  - `type` — SplatEditSdfType enum
  - `opacity` — 0-1
  - `color` — THREE.Color
  - `radius` — shape-specific (sphere radius, box corner rounding, cone angle)
  - `displace` — THREE.Vector3 displacement applied to splats inside shape
  - `invert` — boolean

### SparkRenderer
- Manages global splat rendering pipeline
- Auto-created if not explicitly added to scene
- Handles splat sorting (back-to-front painter's algorithm)
- Single instanced draw call for all splats
- Has utility: `bakeRgba()` — bakes computed RGBA (including SplatEdit effects) into values

### SplatLoader
- THREE.Loader-compatible class for async loading with progress
- `loader.loadAsync(url, progressCallback)` → PackedSplats

## Import Pattern
```typescript
import {
  SplatMesh,
  SplatEdit,
  SplatEditSdf,
  SplatEditSdfType,
  SplatEditRgbaBlendMode,
  PackedSplats,
  SparkRenderer,
  SplatLoader,
  utils
} from "@sparkjsdev/spark";
```

## Example: Delete Sphere
```typescript
const edit = new SplatEdit({
  rgbaBlendMode: SplatEditRgbaBlendMode.MULTIPLY,
  softEdge: 0.05,
});
const sphere = new SplatEditSdf({
  type: SplatEditSdfType.SPHERE,
  opacity: 0,
  radius: 0.5,
});
sphere.position.set(3.0, 1.0, -2.0);
edit.add(sphere);
splatMesh.add(edit); // scoped to this mesh
```

## Example: Recolor Box
```typescript
const edit = new SplatEdit({
  rgbaBlendMode: SplatEditRgbaBlendMode.SET_RGB,
  softEdge: 0.1,
});
const box = new SplatEditSdf({
  type: SplatEditSdfType.BOX,
  color: new THREE.Color(0.8, 0.2, 0.1), // red brick
});
box.position.set(5.0, 2.0, 0.0);
box.scale.set(2.0, 4.0, 2.0);
edit.add(box);
splatMesh.add(edit);
```

## Example: Additive Lighting (Spotlight)
```typescript
const edit = new SplatEdit({
  rgbaBlendMode: SplatEditRgbaBlendMode.ADD_RGBA,
  softEdge: 0.3,
});
const cone = new SplatEditSdf({
  type: SplatEditSdfType.INFINITE_CONE,
  color: new THREE.Color(0.3, 0.25, 0.1), // warm light
  opacity: 0,  // don't add opacity, just color
  radius: 0.5, // cone angle factor
});
cone.position.set(2.0, 5.0, 0.0);
cone.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI); // point down
edit.add(cone);
scene.add(edit); // global effect
```

## 2026-02-26 Spike Notes (T02/T03)

- `SplatMesh` + `SparkRenderer` + `OrbitControls` compile and build cleanly with:
  - `const sparkRenderer = new SparkRenderer({ renderer })`
  - `scene.add(sparkRenderer)`
  - `const splatMesh = new SplatMesh({ url: "/scenes/<file>.spz" })`
  - `splatMesh.quaternion.set(1, 0, 0, 0)` before/while loading
  - `await splatMesh.initialized`
- `splatMesh.getBoundingBox()` is used to log min/max/center/size and fit the camera automatically for unknown Marble export coordinates/scales.
- Standard Three.js raycasting path is wired (`raycaster.intersectObjects(scene.children, true)`), then filtered to the active `SplatMesh`. This keeps Spark raycast integration behind the normal Three API.
- `SplatEdit` / `SplatEditSdf` construction used in spike code:
  - `new SplatEdit({ rgbaBlendMode, softEdge })`
  - `new SplatEditSdf({ type, radius, color, opacity })`
  - `edit.addSdf(sdf)` (preferred over generic `add()` in the spike code)
- Spike parenting/scoping coverage in code:
  - Delete + recolor edits added to `splatMesh` (scoped)
  - Additive lighting edit added to `scene` (global)
- Timed edit removal is implemented by `parent.remove(edit)` and optional `dispose()` call if present at runtime (not declared in current `.d.ts` for `SplatEdit`).
- Visual behavior (hole/recolor/additive restoration) still requires browser validation; this CLI environment only confirmed successful TypeScript build, not rendered output.

## 2026-02-26 Spatial Index Notes (T06)

- `SplatMesh.forEachSplat()` is now used for one-time voxel indexing (not visual edits), matching the project guidance.
- Spatial index implementation details:
  - default resolution `20x20x20`
  - cropped bounds from `splatMesh.getBoundingBox()` with Y crop `[0.1, 0.1]`
  - fallback to uncropped bounds if Y crop becomes invalid
  - per-cell accumulates centroid, avgColor, scalar color variance, density, occupied extents, and `splatIndices`
- Grid build logs include occupied cell count, indexed/total splats, and elapsed milliseconds with `[spatial]` prefix.
- `serializeSpatialGridForLLM()` intentionally excludes `splatIndices` to keep prompt payload size down.
- Runtime performance measurements are still pending manual browser execution (not measurable in this sandbox because the dev server cannot bind a local port).
