# TODO.md — Marble Muse

## Priority Tiers

- **🔴 P0 — MVP (MUST work for demo):** Without these, there is no demo.
- **🟡 P1 — V2 (SHOULD work, demo if ready):** These make the demo winning-tier.
- **🟢 P2 — Stretch (mention in pitch, show mockup if not working):** These show vision.

---

## ═══════════════════════════════════════════
## 🔴 P0 — MVP
## ═══════════════════════════════════════════

### T01: Project Scaffolding
- **Status:** IN PROGRESS (implemented; local `npm run dev` manual verify pending outside sandbox)
- **Depends on:** Nothing
- **Produces:** Working Vite + Three.js + Spark + TypeScript project
- **Tasks:**
  - [x] `npm create vite@latest marble-muse -- --template vanilla-ts` (equivalent scaffold already present in repo)
  - [x] Install deps: `three`, `@sparkjsdev/spark`
  - [x] Configure `vite.config.ts` (ensure .spz files served from public/)
  - [x] Configure `tsconfig.json` (strict mode, ESNext target)
  - [x] Create directory structure per README
  - [x] Create `/codex` directory with empty `gotchas.md`, `worklog.md`, `decisions.md`, `spark-api-notes.md` (repo already initialized; files now updated)
  - [x] Create `.env` with `VITE_ANTHROPIC_API_KEY=`
  - [x] Create `.gitignore` (node_modules, dist, .env)
  - [ ] Verify `npm run dev` serves on localhost (blocked in sandbox: `listen EPERM`)
- **Acceptance:** Running dev server with empty page, no errors in console.

---

### T02: Spark Viewer — Basic Scene Loading
- **Status:** IN PROGRESS (implemented; browser visual verification pending)
- **Depends on:** T01
- **Produces:** `src/viewer.ts`, `src/main.ts` — renders a .spz file in the browser with orbit controls
- **Tasks:**
  - [x] Implement `viewer.ts`: init Three.js scene, camera, WebGLRenderer
  - [x] Add SparkRenderer to scene
  - [x] Load a test .spz file via `new SplatMesh({ url: "/scenes/test.spz" })` (using Marble file in `public/scenes/`)
  - [x] Apply quaternion fix: `splatMesh.quaternion.set(1, 0, 0, 0)`
  - [x] Wait for `await splatMesh.initialized`
  - [x] Add OrbitControls
  - [x] Set up render loop via `renderer.setAnimationLoop()`
  - [x] Export: `splatMesh`, `scene`, `camera`, `renderer`, `canvas`
  - [x] Wire up in `main.ts`
- **Test:** Place any .spz file in `public/scenes/`. Scene renders and you can orbit around it.
- **Notes:** Get a .spz file from Marble's gallery exports or use Spark's demo files (e.g., `https://sparkjs.dev/assets/splats/butterfly.spz` for initial testing — switch to Marble export ASAP).

---

### T03: Spark SplatEdit Spike — Validate Editing Works
- **Status:** IN PROGRESS (spike code implemented; visual validation pending)
- **Depends on:** T02
- **Produces:** Proof that SplatEdit SDF operations work on loaded Marble .spz scenes
- **Tasks:**
  - [x] Hardcode a `SplatEdit` with `MULTIPLY` mode, `opacity: 0`
  - [x] Add a `SplatEditSdf` sphere at a known position in the scene
  - [ ] Verify splats in that sphere become invisible (manual browser check pending)
  - [x] Test `SET_RGB` mode — change color of a region (spike code added)
  - [x] Test `ADD_RGBA` mode — add light to a region (spike code added)
  - [x] Test `softEdge` parameter — verify feathered boundaries (configured in all spike edits; visual check pending)
  - [x] Test adding a `SplatEdit` as child of `SplatMesh` (scoped) vs child of `scene` (global)
  - [x] Test removing/disposing a `SplatEdit` — verify splats come back (timed removal code added; visual check pending)
  - [x] Document all findings in `/codex/spark-api-notes.md`
- **Test:** Visible sphere-shaped hole in the scene where splats are hidden. Color change in another region. Light added in a third region.
- **CRITICAL: This is the highest-risk task. If SplatEdit doesn't work on Marble .spz files, the project needs to pivot. Do this IMMEDIATELY after T02.**

---

### T04: Click-to-Select via Raycasting
- **Status:** IN PROGRESS (implemented; manual click validation/perf notes pending)
- **Depends on:** T02
- **Produces:** Click on the scene → get 3D world position + visual feedback
- **Tasks:**
  - [x] Add click event listener to canvas
  - [x] Use Three.js Raycaster + `raycaster.intersectObjects(scene.children)`
  - [x] Extract `intersects[0].point` as THREE.Vector3 world position (first splat hit after filtering to active SplatMesh)
  - [x] Add a visual indicator at click point (wireframe sphere using Three.js mesh, not splats)
  - [x] Auto-remove indicator after 3 seconds or on next click (implemented on next click / miss)
  - [x] Export: `onSplatClick(callback: (point: THREE.Vector3) => void)`
  - [ ] Test with different positions in the scene (manual browser check pending)
  - [ ] Document raycasting performance in `/codex/spark-api-notes.md` (performance not yet measured)
- **Test:** Click anywhere in the scene → small wireframe sphere appears at the 3D position you clicked.

---

### T05: Types Definition
- **Status:** DONE (implemented in `src/types.ts`)
- **Depends on:** Nothing (but informed by T03 findings)
- **Produces:** `src/types.ts` with all shared interfaces
- **Tasks:**
  - [x] Define all interfaces from AGENTS.md types section
  - [x] Ensure EditOperation shapes match Spark's SplatEditSdfType enum values
  - [x] Export all types
- **Test:** Compiles with no errors. Imported by other modules.

---

### T06: Spatial Index — Voxel Grid
- **Status:** DONE (implemented, compiles, integrated into main.ts; runtime timing/manual validation pending)
- **Depends on:** T02, T05
- **Produces:** `src/spatial-index.ts` — builds voxel grid from loaded SplatMesh
- **Tasks:**
  - [x] Get bounding box via `splatMesh.getBoundingBox()`
  - [x] Crop Y axis (exclude bottom 10%, top 10%)
  - [x] Compute cell dimensions for 20×20×20 grid over cropped bounds
  - [x] Iterate all splats via `splatMesh.forEachSplat()`
  - [x] For each splat: compute grid cell, accumulate centroid/color/count/indices
  - [x] Store occupied cells in a Map keyed by `"x,y,z"` string
  - [x] Compute per-cell stats: average color, color variance, density, bounding box
  - [x] Implement `getCellAtWorldPos(pos: THREE.Vector3): VoxelCell | null`
  - [x] Implement `getNeighborCells(cell: VoxelCell, radius: number): VoxelCell[]`
  - [x] Implement `serializeForLLM(): string` — JSON of occupied cells (positions, colors, densities, dimensions) suitable for Claude's context (`serializeSpatialGridForLLM`)
  - [x] Measure and log time taken for grid construction (logging implemented; needs runtime measurement in browser)
- **Test:** After scene loads, grid builds in < 1 second. `getCellAtWorldPos` returns correct cell for a known position. Serialized JSON is < 50KB.

---

### T07: Agent — Claude Command Pipeline
- **Status:** TODO
- **Depends on:** T05, T06
- **Produces:** `src/agent.ts` — takes user command + context → returns EditOperation[]
- **Tasks:**
  - [ ] Write the system prompt. This is the most critical piece. It should:
    - Explain the role: "You are a spatial editing assistant for 3D gaussian splat worlds"
    - List available SDF shape types and their parameters
    - List available blend modes and their effects
    - Explain the coordinate system
    - Provide examples of command → EditOperation JSON mappings
    - Instruct to set `extractAsset: true` on delete operations
    - Instruct to use compound shapes for complex regions
    - Instruct to use `softEdge` for natural-looking edits
  - [ ] Implement `processCommand(command: string, clickPos: Vector3 | null, voxelContext: string, screenshot: string): Promise<EditOperation[]>`
  - [ ] Construct the user message: scene manifest summary + click position + nearby voxel cell data + screenshot (base64) + user command
  - [ ] Call Claude API (Sonnet) with vision
  - [ ] Parse response — extract JSON from Claude's response (handle markdown code blocks)
  - [ ] Validate parsed operations against type definitions
  - [ ] Handle errors gracefully (API timeout, malformed response, etc.)
  - [ ] Add retry logic (1 retry on failure)
  - [ ] Log all requests/responses to console with `[agent]` prefix
- **Test:** Type "remove this" with a click position → get back a valid EditOperation with action "delete", a sphere shape at the click position. Type "make everything warmer" → get back an atmosphere operation with global SDF.

---

### T08: Executor — EditOperation to SplatEdit
- **Status:** TODO
- **Depends on:** T03 (proven SplatEdit works), T05, T07
- **Produces:** `src/executor.ts` — creates Spark objects from EditOperation JSON
- **Tasks:**
  - [ ] Implement `executeOperations(ops: EditOperation[], splatMesh: SplatMesh): SplatEdit[]`
  - [ ] Map `EditOperation.blendMode` → `SplatEditRgbaBlendMode`
  - [ ] Map `SDFShapeConfig.type` → `SplatEditSdfType`
  - [ ] Create `SplatEdit` with correct parameters
  - [ ] Create `SplatEditSdf` children with position, radius, color, opacity, scale, rotation
  - [ ] Add edit to splatMesh (scoped) or scene (for global effects)
  - [ ] Return created edits (for undo tracking)
  - [ ] Implement `undoLastEdit()` — removes last SplatEdit from scene and disposes
  - [ ] Maintain edit history array
- **Test:** Hardcode an EditOperation, pass to executor, verify SplatEdit appears in scene correctly.

---

### T09: Basic Chat UI
- **Status:** TODO
- **Depends on:** T04, T07, T08
- **Produces:** `src/ui.ts` — chat input at bottom of screen, wired to agent → executor pipeline
- **Tasks:**
  - [ ] Create fixed-bottom chat input bar (text input + send button)
  - [ ] Show loading spinner while Claude is processing
  - [ ] Display brief confirmation toast on successful edit ("Tree removed ✓")
  - [ ] Display error messages if agent fails
  - [ ] Wire: user types → agent.processCommand() → executor.executeOperations()
  - [ ] Pass click position from last click event (if any) to agent
  - [ ] Pass current screenshot to agent
  - [ ] Add keyboard shortcut: Enter to send, Ctrl+Z to undo
  - [ ] Minimal styling — dark semi-transparent panel, clean fonts
- **Test:** Full flow: load scene → click on an object → type "remove this" → object disappears within 3-4 seconds.

---

### T10: Scene Manifest (Simplified for MVP)
- **Status:** DONE (implemented with heuristic labeling, flood-fill grouping, description generation)
- **Depends on:** T06
- **Produces:** `src/scene-manifest.ts` — basic scene understanding without full Claude Vision analysis
- **Tasks:**
  - [x] For MVP: skip the multi-angle Claude Vision analysis
  - [x] Instead, just serialize the spatial grid as the "manifest"
  - [x] Include: occupied cell positions, average colors, densities, estimated labels based on color/height heuristics (green + tall = tree, grey + flat + y≈0 = road, etc.)
  - [x] This gives the agent enough spatial context without an extra API call
  - [x] Implement `getManifestJSON(): string`
- **Notes:** Full Claude Vision scene understanding is P1. For MVP, the voxel grid + click position + screenshot is enough context for the agent to reason about edits.
- **Test:** Manifest JSON is < 50KB, contains meaningful spatial information.

---

### T11: Demo Preparation
- **Status:** TODO
- **Depends on:** T01–T10 all passing
- **Produces:** Demo-ready state
- **Tasks:**
  - [ ] Export 2-3 scenes from Marble (.spz format, 500k splat version for web performance)
  - [ ] Place in `public/scenes/`
  - [ ] Test the full edit flow on each scene
  - [ ] Identify "hero objects" in each scene that demo well (isolated trees, distinct buildings, clear sky regions)
  - [ ] Write down the exact demo script with timings
  - [ ] Test undo flow
  - [ ] Test multiple edits in sequence
  - [ ] Optimize Claude prompt based on testing (iterate on system prompt for better shape outputs)
  - [ ] Build and test production build: `npm run build && npx serve dist`
  - [ ] Measure and verify acceptable performance (>30fps on a laptop)
- **Test:** Can run through the 60-second demo script smoothly with no errors.

---

## ═══════════════════════════════════════════
## 🟡 P1 — V2 (Demo if ready)
## ═══════════════════════════════════════════

### T12: Asset Extraction on Delete
- **Status:** TODO
- **Depends on:** T08 (executor), T06 (spatial index)
- **Produces:** `src/asset-library.ts` (extraction part) — deleted splats saved as reusable assets
- **Tasks:**
  - [ ] When executor processes a delete operation with `extractAsset: true`:
  - [ ] Get the SDF shape parameters (position, radius, type)
  - [ ] Iterate splats via `forEachSplat()`, test each against the SDF region
  - [ ] For sphere: distance from center < radius
  - [ ] For box: within bounds
  - [ ] Collect matching splat data (copy center, scales, quaternion, opacity, color)
  - [ ] Filter: discard splats where color deviates significantly from cluster average (debris/ground/sky contamination)
  - [ ] Filter: discard splats with opacity < 0.1
  - [ ] Normalize positions: subtract cluster centroid so asset is centered at origin
  - [ ] Create a new `PackedSplats`, `pushSplat()` each filtered splat
  - [ ] Create `AssetEntry` with metadata
  - [ ] Add to in-memory asset library array
  - [ ] Log: `[library] Extracted ${count} splats as "${label}"`
- **Test:** Delete a tree → asset library now contains a "tree" entry with splat data.

---

### T13: Asset Library UI
- **Status:** TODO
- **Depends on:** T12
- **Produces:** Sidebar UI showing extracted assets
- **Tasks:**
  - [ ] Create collapsible right sidebar panel
  - [ ] For each asset: render a thumbnail
    - Create temporary SplatMesh from asset's PackedSplats
    - Render to offscreen WebGLRenderer (small canvas, e.g. 128x128)
    - Convert to dataURL for the thumbnail image
  - [ ] Display grid of thumbnails with labels and splat counts
  - [ ] Click thumbnail to select asset for placement
  - [ ] Visual indicator when asset is selected (highlighted border)
  - [ ] "Placement mode" — next click in scene places the asset
- **Test:** Delete an object → it appears in the sidebar → click it → click in scene → object appears at new location.

---

### T14: Asset Placement
- **Status:** TODO
- **Depends on:** T13
- **Produces:** Click-to-place flow for library assets
- **Tasks:**
  - [ ] When in placement mode and user clicks in scene:
  - [ ] Get world position from raycast
  - [ ] Create new SplatMesh from asset's PackedSplats
  - [ ] Set `maxSh: 0` on placed mesh (avoid SH view-dependent artifacts)
  - [ ] Position at click point
  - [ ] Set quaternion to match scene orientation: `quaternion.set(1, 0, 0, 0)`
  - [ ] Add to scene
  - [ ] Exit placement mode
  - [ ] Show confirmation toast
- **Test:** Full cycle: delete tree from Scene A → tree appears in library → place tree in Scene A at new location (or Scene B).

---

### T15: Full Scene Manifest via Claude Vision
- **Status:** TODO
- **Depends on:** T06, T10
- **Produces:** Enhanced `src/scene-manifest.ts` with Claude Vision analysis
- **Tasks:**
  - [ ] Capture screenshots from 4-6 angles (programmatically move camera, render, capture)
  - [ ] Send screenshots + grid JSON to Claude Vision
  - [ ] Parse response into SemanticRegion[] with labels
  - [ ] Cache manifest as JSON file for demo scenes
  - [ ] Update agent.ts to include richer semantic context
- **Test:** Manifest correctly identifies major objects in the scene with reasonable labels.

---

### T16: Multi-Scene Support
- **Status:** TODO
- **Depends on:** T02, T09
- **Produces:** Ability to load and switch between multiple .spz scenes
- **Tasks:**
  - [ ] Add scene selector dropdown to UI
  - [ ] Load multiple SplatMeshes (one visible at a time, or side-by-side split view)
  - [ ] Each scene has its own spatial index and manifest
  - [ ] Asset library is shared across scenes
  - [ ] Placement works across scenes
- **Test:** Load Scene A and Scene B. Delete object from A. Switch to B. Place object from library into B.

---

### T17: Edit Refinement Loop
- **Status:** TODO
- **Depends on:** T09
- **Produces:** Ability to iteratively refine edits through conversation
- **Tasks:**
  - [ ] After an edit, show: "How does that look? You can say 'a bit bigger' or 'shift it left'"
  - [ ] Agent receives: previous edit parameters + user refinement → outputs adjusted operation
  - [ ] Executor removes previous edit, applies new one
  - [ ] Support: "undo that", "bigger", "smaller", "more to the left", "include more area"
- **Test:** "Remove that tree" → "missed the top branches" → agent expands sphere radius → tree fully removed.

---

## ═══════════════════════════════════════════
## 🟢 P2 — Stretch Goals
## ═══════════════════════════════════════════

### T18: Voice Input
- **Status:** TODO
- **Depends on:** T09
- **Tasks:**
  - [ ] Add microphone button to chat UI
  - [ ] Use Web Speech API for speech-to-text
  - [ ] Feed transcribed text into the same agent pipeline
  - [ ] For demo: talking to the world is more dramatic than typing

### T19: Cross-Scene Compositing (CPU Path)
- **Status:** TODO
- **Depends on:** T16
- **Tasks:**
  - [ ] Load two .spz scenes as separate SplatMeshes
  - [ ] Use forEachSplat on source scene to extract region
  - [ ] pushSplat into target scene's PackedSplats with position transform
  - [ ] Handle coordinate alignment between scenes

### T20: Pre-Populated Asset Library
- **Status:** TODO
- **Depends on:** T12, T13
- **Tasks:**
  - [ ] Before hackathon: extract 30-50 assets from various Marble scenes
  - [ ] Serialize as .spz or PackedSplats JSON blobs
  - [ ] Load on app startup
  - [ ] Categorize: vegetation, architecture, vehicles, furniture, lighting

### T21: Undo/Redo Stack with Visual Timeline
- **Status:** TODO
- **Depends on:** T08
- **Tasks:**
  - [ ] Visual timeline at top of screen showing edit history
  - [ ] Click any point in timeline to revert to that state
  - [ ] Each entry shows thumbnail + description

### T22: Export Edited Scene
- **Status:** TODO
- **Depends on:** T08
- **Tasks:**
  - [ ] "Bake" all SplatEdits into the actual PackedSplats using SparkRenderer's bake utility
  - [ ] Export as .spz or .ply for use in other tools
  - [ ] This closes the loop: Marble → edit → export → Marble/Unity/Unreal

---

## Agent Assignment Guide

When asking the orchestrator (Claude Chat) for the next agent prompt, reference the task ID (e.g., "Give me the prompt for T02"). The orchestrator will provide a detailed prompt scoped to that task, including:
- All relevant context from this TODO
- Specific files to create/modify
- Acceptance criteria
- Which `/codex` files to update

**Parallel-safe tasks** (can be assigned to separate agents simultaneously):
- T01 + T05 (scaffolding + types — no file conflicts)
- T06 + T09 (spatial index + UI — independent modules)
- T12 + T15 (asset extraction + scene manifest — independent features)

**Sequential dependencies** (must complete in order):
- T01 → T02 → T03 (scaffolding → viewer → SplatEdit spike)
- T03 → T08 (spike validates approach → build executor)
- T06 → T07 → T08 → T09 (spatial index → agent → executor → UI)
- T08 → T12 → T13 → T14 (executor → extraction → library UI → placement)
