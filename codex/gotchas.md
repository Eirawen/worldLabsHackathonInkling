# Gotchas — Marble Muse

## Spark

1. **Coordinate system fix required.** Marble .spz exports use OpenCV conventions. Set `splatMesh.quaternion.set(1, 0, 0, 0)` after loading to convert to OpenGL/Three.js convention.

2. **Raycasting is expensive on large splat counts.** `splatMesh.raycast()` uses WASM and iterates all points synchronously. On 2M splats, noticeable delay. Use 500k splat exports for web performance. Only raycast on click events, NEVER per-frame.

3. **forEachSplat reuses callback objects.** The `center`, `scales`, `quaternion`, `opacity`, `color` passed to the callback are the SAME objects every iteration. If you need to store values, you MUST copy: `new THREE.Vector3().copy(center)`.

4. **PackedSplats needsUpdate.** After calling `setSplat()` or `pushSplat()`, you must set `packedSplats.needsUpdate = true` to trigger GPU upload. Without this, visual changes won't appear.

5. **SplatEdit position is world-space.** The SDF shapes in a SplatEdit operate in world coordinates. Make sure positions match the actual world-space location of splats in the scene.

6. **SplatMesh scale is uniform only.** `scale.set(x, y, z)` will average the three values. Use `scale.setScalar(x)` for consistent behavior.

7. **SplatEdit disposal.** To undo an edit, remove the SplatEdit from its parent (`parent.remove(edit)`) and call `edit.dispose()` if available. The splats should revert to their original appearance since SplatEdits are non-destructive GPU-side modifications.

8. **PackedSplats is 16 bytes/splat.** Positions are float16 (limited precision), colors uint8 sRGB, scales log-encoded uint8. When extracting and re-inserting splats, some precision loss is expected. This is generally not visually noticeable.

## Marble Export

9. **Use 500k splat exports for web.** The 2M splat version is ~180MB .ply / ~25MB .spz. The 500k version is much more manageable (~45MB .ply, much smaller .spz). For web demos, 500k is the right choice.

10. **Marble exports are static.** No animations transfer. All geometry is frozen at export time.

11. **SPZ vs PLY.** SPZ is ~10x smaller with minimal visual difference. Always prefer .spz for web delivery. Spark supports both natively.

## Claude API

12. **Browser CORS.** For direct browser calls to Claude API, you need the `anthropic-dangerous-direct-browser-access` header. This is fine for hackathon demos but not production.

13. **Response parsing.** Claude sometimes wraps JSON in markdown code blocks (```json ... ```). Always strip these before parsing. Regex: `/```json?\s*([\s\S]*?)```/`

14. **Vision input size.** Base64 screenshots can be large. Resize to ~512x512 before encoding to keep prompt size manageable and response times fast.

## Viewer / Spike Implementation

15. **`raycaster.intersectObjects(scene.children, true)` can hit non-splat objects.** Once you add helpers (wireframe click indicator) or `SparkRenderer` to the scene, the first hit may not be the `SplatMesh`. Filter intersections by walking parents and keeping only hits inside the active `SplatMesh`.

16. **Unknown Marble export scale/position makes hardcoded edit coordinates unreliable.** Fit the camera from `splatMesh.getBoundingBox()` and place SplatEdit spike anchors relative to bounds center/size instead of assuming origin-centered content.

17. **Spatial-index Y-crop can collapse on tiny/flat scenes.** Cropping 10% off top and bottom of the Y range may produce an invalid box when the source height is near zero. Detect this and fall back to uncropped bounds instead of building an empty/broken grid.

18. **Keep density comparable across cells.** If density is computed from occupied extents (`worldBounds`) instead of nominal voxel volume, sparse cells with tight point clusters look artificially dense. Use nominal grid-cell volume for stable cross-cell comparisons.

19. **THREE.Color.getHSL() returns hue 0-1, not 0-360.** When using hue for classification heuristics, multiply by 360 to get degrees. The `scene-manifest.ts` color classifier works in degree-space (0-360) after conversion.

20. **Scene-manifest heuristic labels are hints, not ground truth.** The color/height classification in `scene-manifest.ts` (T10 MVP) uses simple rules (green=vegetation, grey+low=ground, etc.). Indoor scenes like libraries will mostly get "structure" and "warm_surface" labels. The labels are context for the LLM agent, not reliable identifiers. Full Claude Vision analysis (T15) is needed for accurate labeling.

21. **Gemini SDK increases client bundle size.** Adding `@google/genai` in browser builds increased the main bundle size warning threshold in Vite. For demo stability this is acceptable, but production should consider code-splitting the agent path or moving LLM calls behind a backend proxy.

22. **Placed extracted assets also need the Spark orientation quaternion.** When re-inserting an extracted `PackedSplats` asset via `new SplatMesh({ packedSplats })`, set `mesh.quaternion.set(1, 0, 0, 0)` before placement. Using identity quaternion can produce incorrect orientation relative to the loaded scene.

23. **Verbose UI logging can expose command/context internals.** Current classic UI logs include user command text, manifest/voxel preview snippets, and raw agent JSON output. Great for local debugging, but disable/reduce these logs before public demos if terminal privacy/noise matters.
