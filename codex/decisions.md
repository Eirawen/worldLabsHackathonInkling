# Architecture Decisions — Marble Muse

## AD-001: Use Spark SplatEdit SDF system for edits, not raw buffer mutation
**Date:** 2026-02-26
**Decision:** All visual edits (delete, recolor, lighting) use Spark's GPU-side SplatEdit/SplatEditSdf system rather than CPU-side PackedSplats mutation.
**Rationale:** SplatEdits run on the GPU at 60fps with zero CPU-GPU data transfer. They support soft edges, shape blending, and multiple blend modes. They are non-destructive and reversible. CPU-side mutation via forEachSplat/setSplat is reserved only for asset extraction and cross-scene compositing.

## AD-002: 20×20×20 uniform voxel grid over cropped bounding box
**Date:** 2026-02-26
**Decision:** Spatial index uses a uniform 20×20×20 grid over the Y-cropped (10% top/bottom excluded) bounding box. Not octree, not DBSCAN.
**Rationale:** Simple to implement (<100 lines), fast to build (<500ms for 500k splats), produces ~100-300 occupied cells which fits easily in Claude's context window. Provides sufficient spatial resolution for the LLM to reason about object locations. Octree was considered but adds complexity without proportional benefit for hackathon scope.

## AD-003: Claude (Sonnet) as the spatial reasoning agent
**Date:** 2026-02-26
**Decision:** Use Claude Sonnet via direct API calls with vision for command→SDF translation.
**Rationale:** Best available vision model for spatial reasoning from screenshots + structured data. Sonnet is fast enough (2-4s) for interactive use. Direct browser API calls with `anthropic-dangerous-direct-browser-access` header — acceptable for hackathon, not production.

## AD-004: Click-to-select as primary interaction, language as secondary
**Date:** 2026-02-26
**Decision:** Users click to select a region, then type what to do with it. Pure language commands (without click) are supported but click+language is the primary flow.
**Rationale:** Click gives us an exact 3D position via Spark's raycast, which feeds the LLM precise spatial context. This sidesteps the hard problem of the LLM needing to identify 3D locations from language alone. The click point also determines which voxel cells to include in the context, keeping the prompt focused.

## AD-005: Asset extraction as byproduct of deletion
**Date:** 2026-02-26
**Decision:** Every delete operation simultaneously extracts the affected splats into a reusable asset in the library.
**Rationale:** Deletion already identifies a spatial region. The splat data exists in PackedSplats. Extracting it is minimal additional work (iterate, filter, normalize, store). This creates a flywheel: more editing = richer library = more compositing options. Product narrative: "Every world you touch makes every future world richer."

## AD-006: SH0 for extracted/placed assets
**Date:** 2026-02-26
**Decision:** Assets extracted and placed in new scenes use maxSh=0 (base color only, no view-dependent spherical harmonics).
**Rationale:** Gaussian splats encode view-dependent appearance via spherical harmonics that are optimized for the original scene's camera positions. When splats are moved to a new scene and viewed from different angles, SH can produce color artifacts. SH0 gives consistent (if slightly less realistic) appearance from all angles.

## AD-007: 500k splat exports for web
**Date:** 2026-02-26
**Decision:** Use Marble's 500k splat export option for all web demo scenes, not the 2M version.
**Rationale:** 500k splats render well on laptops, load faster, and raycast faster. The 2M version is more detailed but causes performance issues in browser. For a live demo, smooth 60fps matters more than maximum detail.
