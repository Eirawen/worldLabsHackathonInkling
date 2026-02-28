# AGENTS.md — Marble Muse

## Project Context

You are working on **Marble Muse**, a real-time language-driven editing layer for World Labs' Marble gaussian splat worlds. The app runs in the browser using Vite + Three.js + Spark (World Labs' gaussian splat renderer). Users click on regions of a 3D gaussian splat scene and issue natural language commands that are translated by Claude's API into Spark SplatEdit SDF operations, executed on the GPU in real-time.

**Read the README.md first for full project context.**

---

## Golden Rules

1. **Spark is the renderer. Never bypass it.** All splat rendering, raycasting, and editing goes through Spark's API (`SplatMesh`, `SplatEdit`, `SplatEditSdf`, `PackedSplats`). Do not try to write custom WebGL shaders or manage splat buffers directly.

2. **SplatEdit SDF is the primary edit mechanism.** Edits (delete, recolor, light) are expressed as `SplatEdit` objects containing `SplatEditSdf` shape primitives. These run on the GPU. Do NOT iterate over splats with `forEachSplat()` for visual edits — that's CPU-side and slow for large splat counts.

3. **`forEachSplat()` is only for data extraction and indexing.** Use it for: building the spatial voxel grid on load, and extracting splat data for the asset library. Never for per-frame operations.

4. **PackedSplats uses 16 bytes per splat.** Positions are float16, colors are uint8 sRGB, scales are log-encoded uint8, quaternions are octahedral-encoded. When reading splat data via `forEachSplat()` or `getSplat()`, you get unpacked THREE.js objects. When writing, `setSplat()` / `pushSplat()` handles the packing.

5. **After mutating PackedSplats, set `needsUpdate = true`.** This triggers a CPU→GPU data transfer. Use sparingly — fine for one-time operations (asset placement), not for per-frame updates.

6. **Spark natively supports .spz files.** Just use `new SplatMesh({ url: "scene.spz" })`. No conversion needed. Spark also supports .ply, .splat, .ksplat.

7. **Raycasting is built into SplatMesh.** Use the standard Three.js Raycaster API: `raycaster.intersectObjects(scene.children)`. Spark handles splat-level intersection via WASM. Note: raycasting millions of splats has a delay — do NOT call every frame. Only on click events.

8. **TypeScript throughout.** All source files are `.ts`. Define interfaces for all data structures (voxel cells, scene manifests, edit operations, asset entries).

9. **Keep the `/codex` directory updated.** After completing work, log findings, gotchas, and decisions in the appropriate codex file. Future agents depend on this.

---

## Tech Stack & Versions

```
three: ^0.178.0
@sparkjsdev/spark: ^0.1.10
vite: ^6.x
typescript: ^5.x
```

Import pattern for Spark:
```typescript
import { SplatMesh, SplatEdit, SplatEditSdf, SplatEditSdfType, SplatEditRgbaBlendMode, PackedSplats, SparkRenderer, SplatLoader, utils } from "@sparkjsdev/spark";
```

Import pattern for Three.js:
```typescript
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
```

---

## Architecture & Module Responsibilities

### Dependency Graph

```
main.ts
  ├── viewer.ts          (no deps besides Three/Spark)
  ├── spatial-index.ts   (depends on: viewer.ts for SplatMesh access)
  ├── scene-manifest.ts  (depends on: spatial-index.ts, viewer.ts)
  ├── agent.ts           (depends on: scene-manifest.ts, types.ts)
  ├── executor.ts        (depends on: viewer.ts for scene access, types.ts)
  ├── asset-library.ts   (depends on: viewer.ts, spatial-index.ts, types.ts)
  ├── ui.ts              (depends on: all above modules)
  └── types.ts           (no deps — shared interfaces)
```

### Module Specifications

#### `types.ts` — Shared Type Definitions
No dependencies. Define all interfaces here.

```typescript
// Key interfaces to define:

interface VoxelCell {
  gridPos: [number, number, number];  // Grid coordinates
  worldCenter: THREE.Vector3;         // World-space centroid
  worldBounds: THREE.Box3;            // World-space bounding box
  splatCount: number;                 // Number of splats in cell
  avgColor: THREE.Color;              // Average color of splats
  colorVariance: number;              // Color variance (high = mixed content)
  density: number;                    // Splats per unit volume
  splatIndices: number[];             // Indices into PackedSplats (for extraction)
}

interface SpatialGrid {
  resolution: [number, number, number]; // Grid dimensions (e.g. [20, 20, 20])
  worldBounds: THREE.Box3;              // Total world bounding box (cropped)
  cellSize: THREE.Vector3;              // World-space size of each cell
  cells: Map<string, VoxelCell>;        // Key: "x,y,z" string
}

interface SceneManifest {
  description: string;          // Natural language scene description
  regions: SemanticRegion[];    // Identified objects/areas
  grid: SpatialGrid;           // Reference to spatial grid
  screenshots: string[];        // Base64 encoded screenshots from multiple angles
}

interface SemanticRegion {
  label: string;                // e.g. "oak tree", "stone building", "road"
  gridCells: string[];          // Which voxel cells compose this region
  estimatedBounds: THREE.Box3;  // Approximate world-space bounds
  dominantColor: THREE.Color;
  confidence: number;           // 0-1, how confident the labeling is
}

interface EditOperation {
  action: "delete" | "recolor" | "light" | "darken" | "atmosphere";
  shapes: SDFShapeConfig[];
  blendMode: "MULTIPLY" | "SET_RGB" | "ADD_RGBA";
  softEdge?: number;
  sdfSmooth?: number;
  invert?: boolean;
  extractAsset?: boolean;       // If true, also extract splats as asset
  assetLabel?: string;          // Label for extracted asset
}

interface SDFShapeConfig {
  type: "SPHERE" | "BOX" | "ELLIPSOID" | "CYLINDER" | "CAPSULE" | "PLANE" | "INFINITE_CONE" | "ALL";
  position: [number, number, number];
  rotation?: [number, number, number, number]; // Quaternion
  radius?: number;
  scale?: [number, number, number];
  color?: [number, number, number];  // 0-1 RGB
  opacity?: number;
  displace?: [number, number, number];
}

interface AssetEntry {
  id: string;
  label: string;
  sourceScene: string;
  extractedAt: Date;
  splats: PackedSplats;
  thumbnailDataUrl: string;     // Rendered thumbnail
  originalPosition: THREE.Vector3;
  bounds: THREE.Box3;
  splatCount: number;
}
```

#### `viewer.ts` — Spark Viewer Setup
Responsibilities:
- Initialize Three.js scene, camera, WebGL renderer
- Create SparkRenderer and add to scene
- Load .spz file into SplatMesh
- Set up OrbitControls
- Handle raycasting on click events
- Provide screenshot capture (`renderer.domElement.toDataURL()`)
- Expose: `splatMesh`, `scene`, `camera`, `renderer`, `getScreenshot()`, `onSplatClick(callback)`

Key Spark patterns:
```typescript
const splatMesh = new SplatMesh({ url: "/scenes/city.spz" });
splatMesh.quaternion.set(1, 0, 0, 0); // OpenCV to OpenGL coordinate fix
scene.add(splatMesh);

// Wait for load
await splatMesh.initialized;

// Raycast on click
canvas.addEventListener("click", (event) => {
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(
    new THREE.Vector2(
      (event.clientX / canvas.width) * 2 - 1,
      -(event.clientY / canvas.height) * 2 + 1
    ),
    camera
  );
  const intersects = raycaster.intersectObjects(scene.children);
  // intersects[i].point gives THREE.Vector3 world position
  // intersects[i].object gives the SplatMesh
});
```

#### `spatial-index.ts` — Voxel Grid Construction
Responsibilities:
- After SplatMesh loads, iterate all splats via `forEachSplat()`
- Compute bounding box via `splatMesh.getBoundingBox()`
- Crop bounding box (exclude bottom 10% and top 10% by Y — ground and sky)
- Divide cropped volume into 20×20×20 grid
- For each splat, assign to grid cell, accumulate stats
- Store splat indices per cell (needed for asset extraction)
- Export occupied cells only as JSON for the LLM

Key performance note: iterating 500k splats in JS takes ~200-500ms. This is fine as a one-time cost on load. Do it synchronously or in a Web Worker if needed.

```typescript
splatMesh.forEachSplat((index, center, scales, quaternion, opacity, color) => {
  // center, scales, etc are reused objects — copy values if storing
  const x = center.x, y = center.y, z = center.z;
  // ... grid cell assignment
});
```

#### `scene-manifest.ts` — Scene Understanding
Responsibilities:
- Take 4-6 screenshots from different camera angles (front, back, left, right, top, bird's-eye)
- Serialize the spatial grid's occupied cells to JSON
- Send grid JSON + screenshots to Claude Vision API
- Parse Claude's response into a `SceneManifest` with semantic region labels
- Cache the manifest — this is a one-time operation per scene

The LLM prompt should ask Claude to:
1. Describe the scene in natural language
2. Identify distinct objects/regions
3. Map them to grid cell clusters
4. Assign semantic labels with confidence scores

**This can be pre-computed for demo scenes and saved as JSON.**

#### `agent.ts` — Language-to-Edit Pipeline
Responsibilities:
- Accept: user command (string), click position (Vector3 | null), current screenshot, scene manifest
- If click position provided, look up the voxel cell and its neighbors, include bounding box and color data
- Construct the Claude API prompt with all context
- Parse Claude's structured JSON response into `EditOperation[]`
- Handle edge cases: clarification requests, multi-step edits, undo

The Claude system prompt should instruct it to:
1. Reason about what the user wants
2. Determine which SDF shapes best approximate the target region
3. Output a JSON array of `EditOperation` objects
4. For delete operations, set `extractAsset: true` and provide a descriptive `assetLabel`

**Critical: the agent prompt engineering is the most important part of this module. Invest heavily in the system prompt. Test with multiple scene types and commands.**

#### `executor.ts` — SplatEdit Factory
Responsibilities:
- Accept `EditOperation[]` from the agent
- Create corresponding Spark `SplatEdit` and `SplatEditSdf` objects
- Add them to the scene (or to the specific SplatMesh)
- Maintain a list of all applied edits (for undo support)
- Trigger asset extraction when `extractAsset: true`

```typescript
function executeOperation(op: EditOperation, splatMesh: SplatMesh): SplatEdit {
  const blendMode = {
    "MULTIPLY": SplatEditRgbaBlendMode.MULTIPLY,
    "SET_RGB": SplatEditRgbaBlendMode.SET_RGB,
    "ADD_RGBA": SplatEditRgbaBlendMode.ADD_RGBA,
  }[op.blendMode];

  const edit = new SplatEdit({
    rgbaBlendMode: blendMode,
    softEdge: op.softEdge ?? 0.05,
    sdfSmooth: op.sdfSmooth ?? 0.0,
    invert: op.invert ?? false,
  });

  for (const shape of op.shapes) {
    const sdf = new SplatEditSdf({
      type: SplatEditSdfType[shape.type],
      opacity: shape.opacity ?? 1.0,
      color: new THREE.Color(shape.color?.[0] ?? 1, shape.color?.[1] ?? 1, shape.color?.[2] ?? 1),
      radius: shape.radius ?? 0.5,
    });
    sdf.position.set(...shape.position);
    if (shape.rotation) sdf.quaternion.set(...shape.rotation);
    if (shape.scale) sdf.scale.set(...shape.scale);
    if (shape.displace) sdf.displace?.set(...shape.displace);
    edit.add(sdf);
  }

  scene.add(edit); // or splatMesh.add(edit) for mesh-specific
  return edit;
}
```

#### `asset-library.ts` — Extraction, Storage, Placement
Responsibilities:
- **Extraction:** Given an `EditOperation` with `extractAsset: true`, iterate splats in the affected SDF region using `forEachSplat()`. For each splat, test whether it falls within the SDF shapes (sphere radius check, box bounds check, etc.). Filter by color coherence and opacity. Normalize positions relative to cluster centroid. Store as a new `PackedSplats`.
- **Storage:** Maintain an in-memory array of `AssetEntry` objects. Render thumbnails by creating a temporary SplatMesh from the extracted PackedSplats, rendering to an offscreen canvas.
- **Placement:** User selects asset from library, clicks in scene. Create a new `SplatMesh` from the asset's `PackedSplats`, position it at the click point, add to scene.

For SH artifacts on reused assets, consider setting `maxSh: 0` on placed asset SplatMeshes to use base color only and avoid view-dependent weirdness.

```typescript
// Placement
const assetMesh = new SplatMesh({ packedSplats: asset.splats });
assetMesh.maxSh = 0; // Base color only for extracted assets
assetMesh.position.copy(clickWorldPosition);
assetMesh.quaternion.set(1, 0, 0, 0);
scene.add(assetMesh);
```

#### `ui.ts` — Interface
Responsibilities:
- Chat panel (bottom of screen): text input, message history, loading indicator
- Library sidebar (right side): scrollable grid of asset thumbnails with labels
- Selection highlight: when user clicks a splat, show a wireframe sphere/box at the click point indicating the affected region
- Operation feedback: brief toast messages ("Tree removed", "Lighting updated", etc.)
- Scene selector: dropdown or tabs to switch between loaded .spz scenes

Keep the UI minimal and clean. This is a demo, not a product. Tailwind via CDN or plain CSS is fine. No React needed — vanilla DOM manipulation.

#### `main.ts` — Orchestration
Responsibilities:
- Initialize viewer
- Wait for SplatMesh load
- Build spatial index
- Generate (or load cached) scene manifest
- Wire up UI events → agent → executor → asset library pipeline
- Handle the render loop

---

## Coding Conventions

- **No classes unless necessary.** Prefer modules exporting functions and plain objects.
- **Async/await everywhere.** No raw promises or callbacks.
- **Error boundaries around Claude API calls.** Network can fail. Always have a fallback or retry.
- **Console.log liberally during development.** Prefix with module name: `[agent]`, `[executor]`, `[spatial]`, etc.
- **No external UI frameworks.** Vanilla TS + DOM. CSS goes in `src/styles.css`.
- **Scenes in `public/scenes/`.** Vite serves these statically.
- **Environment variables in `.env`.** Only `VITE_ANTHROPIC_API_KEY` for now. **IMPORTANT: Claude API calls should go through a tiny backend proxy or be made client-side with appropriate CORS handling. For the hackathon, client-side direct calls are fine.**

---

## Claude API Integration Pattern

```typescript
const response = await fetch("https://api.anthropic.com/v1/messages", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "x-api-key": import.meta.env.VITE_ANTHROPIC_API_KEY,
    "anthropic-version": "2023-06-01",
    "anthropic-dangerous-direct-browser-access": "true",
  },
  body: JSON.stringify({
    model: "claude-sonnet-4-20250514",
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: screenshotBase64 } },
          { type: "text", text: userPromptWithContext }
        ]
      }
    ]
  })
});
```

Use `claude-sonnet-4-20250514` for speed. The agent needs to be fast (2-4 seconds), not maximally intelligent. Sonnet is plenty smart for SDF shape reasoning.

---

## Testing Approach

- **Manual testing during development.** Load a .spz, click around, type commands, verify SplatEdits appear correctly.
- **Pre-bake demo scenes.** Have 2-3 .spz files ready with known objects (trees, buildings, vehicles) for reliable demo flows.
- **Test SDF shapes in isolation first.** Before wiring up the LLM, hardcode a `SplatEdit` with a sphere at a known position and verify it renders. This validates the Spark integration before adding complexity.
- **Log all Claude API responses.** Write them to `/codex/worklog.md` so you can debug prompt issues.

---

## Common Gotchas (update `/codex/gotchas.md` as you discover more)

1. **Spark coordinate system:** .spz uses OpenGL convention (RUB). When loading, set `splatMesh.quaternion.set(1, 0, 0, 0)` to fix orientation.
2. **Raycasting performance:** `splatMesh.raycast()` iterates all splats via WASM. On 2M splats this has noticeable delay. Only call on user click, never per-frame.
3. **PackedSplats needsUpdate:** After `setSplat()` or `pushSplat()`, MUST set `packedSplats.needsUpdate = true`. Without this, changes won't appear.
4. **SplatEdit as scene child vs mesh child:** Adding a SplatEdit to the scene makes it global (affects all editable SplatMeshes). Adding as child of a specific SplatMesh scopes it. For delete operations on a specific scene, add as child of that SplatMesh.
5. **forEachSplat reuses objects:** The center, scales, quaternion, opacity, color objects passed to the callback are **reused across iterations**. If you need to store values, copy them: `new THREE.Vector3().copy(center)`.
6. **SDF position is world-space:** SplatEditSdf positions must be in world-space coordinates matching where the splats actually are in the scene.
7. **Scale on SplatMesh:** Only uniform scaling is supported. `splatMesh.scale.setScalar(x)` works, but `scale.set(x, y, z)` will average the values.
