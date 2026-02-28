# Worklog — Marble Muse

## Format
Each entry: `[DATE] [AGENT/HUMAN] [TASK_ID] — Summary of work done`

---

<!-- Entries will be added here as work progresses -->
[2026-02-26] [AGENT] [T01,T02,T03] — Completed foundation scaffold + Spark viewer + SplatEdit spike wiring. Added `src/main.ts`, finalized `src/viewer.ts` (camera fit from bounding box, SparkRenderer, OrbitControls, click raycast with wireframe indicator, screenshot helper, callback unsubscribe), copied Marble test scene to `public/scenes/elegant_library_with_fireplace_500k.spz`, and added hardcoded delete/recolor/additive `SplatEdit` spike tests with softEdge + timed removal/restore log. `npm run build` passes. `npm run dev` could not be runtime-verified in this environment because sandbox blocks opening a local listening port (`listen EPERM`). 
[2026-02-26] [AGENT] [TESTS] — Started unit test suite by extracting spike helper math/formatting into `src/spike-utils.ts` and adding `tests/spike-utils.test.ts` (fallback anchor behavior, bounds-derived anchor placement, radius clamping, point formatting). Added `vitest` scripts/dependency to `package.json` (dependency install/runtime not verified in sandbox).
[2026-02-26] [AGENT] [T05,T06] — Added `src/types.ts` with shared interfaces (VoxelCell/SpatialGrid/SceneManifest/EditOperation/etc.) and implemented `src/spatial-index.ts` (20x20x20 voxel grid build from `SplatMesh.forEachSplat()`, Y-crop fallback, per-cell stats, queries, LLM serialization). Wired minimal spatial index logging into `src/main.ts` and added `tests/spatial-index.test.ts` for crop/grid mapping/query/serialization helpers. `npm run build` passes. `npm test` currently fails (`vitest: not found`) because `npm install` cannot fetch registry in this environment (`EAI_AGAIN`).
[2026-02-26] [AGENT] [UX] — Added keyboard movement to `src/viewer.ts`: WASD horizontal movement, Q/E vertical movement, and Shift speed boost. Movement translates both `camera.position` and `OrbitControls.target` each frame so OrbitControls remains usable while navigating the scene. `npm run build` passes.
