import {
  SplatEdit,
  SplatEditRgbaBlendMode,
  SplatEditSdf,
  SplatEditSdfType,
} from "@sparkjsdev/spark";
import * as THREE from "three";
import {
  buildSpatialGrid,
  getCellAtWorldPos,
  gridKey,
  serializeSpatialGridForLLM,
} from "./spatial-index";
import { computeSpikeAnchors, formatPoint } from "./spike-utils";
import { initViewer, onSplatClick } from "./viewer";

const DEFAULT_SCENE_FILE = "elegant_library_with_fireplace_500k.spz";

async function bootstrap() {
  const canvas = document.querySelector<HTMLCanvasElement>("#canvas");
  const info = document.querySelector<HTMLDivElement>("#info");

  if (!canvas) {
    throw new Error("Missing #canvas element");
  }

  const sceneUrl = `/scenes/${DEFAULT_SCENE_FILE}`;
  info?.replaceChildren(`Loading ${DEFAULT_SCENE_FILE}...`);

  const viewer = await initViewer(canvas, sceneUrl);

  info?.replaceChildren(`Loaded ${DEFAULT_SCENE_FILE}`);
  console.log("[main] Viewer initialized");

  const spatialGrid = buildSpatialGrid(viewer.splatMesh);
  const spatialJson = serializeSpatialGridForLLM(spatialGrid);
  console.log(
    `[spatial] Grid ready: occupied=${spatialGrid.cells.size}, serializedBytes=${spatialJson.length}`
  );

  let lastClickPoint: THREE.Vector3 | null = null;
  onSplatClick((point) => {
    lastClickPoint = point.clone();
    console.log("[main] Selected point:", point.toArray());

    const hitCell = getCellAtWorldPos(spatialGrid, point);
    if (hitCell) {
      console.log(
        `[spatial] Click cell ${gridKey(...hitCell.gridPos)} splats=${hitCell.splatCount} density=${hitCell.density.toFixed(2)}`
      );
    } else {
      console.log("[spatial] Click point outside indexed grid bounds");
    }
  });

  // TEMP SPIKE (T03): hardcoded SplatEdit validation code. Remove when executor.ts exists.
  const anchors = computeSpikeAnchors(viewer.boundsCenter, viewer.boundsSize);

  const deleteEdit = new SplatEdit({
    rgbaBlendMode: SplatEditRgbaBlendMode.MULTIPLY,
    softEdge: anchors.sphereRadius * 0.35,
  });
  const deleteSphere = new SplatEditSdf({
    type: SplatEditSdfType.SPHERE,
    opacity: 0,
    radius: anchors.sphereRadius,
  });
  deleteSphere.position.copy(anchors.deleteCenter);
  deleteEdit.addSdf(deleteSphere);
  viewer.splatMesh.add(deleteEdit); // scoped edit
  console.log(
    `[spike] Delete sphere applied at ${formatPoint(anchors.deleteCenter)}`
  );

  const recolorEdit = new SplatEdit({
    rgbaBlendMode: SplatEditRgbaBlendMode.SET_RGB,
    softEdge: anchors.sphereRadius * 0.5,
  });
  const recolorBox = new SplatEditSdf({
    type: SplatEditSdfType.BOX,
    color: new THREE.Color(0.95, 0.22, 0.12),
    opacity: 1,
    radius: anchors.sphereRadius * 0.15,
  });
  recolorBox.position.copy(anchors.recolorCenter);
  recolorBox.scale.copy(anchors.boxScale);
  recolorEdit.addSdf(recolorBox);
  viewer.splatMesh.add(recolorEdit); // scoped edit
  console.log("[spike] Recolor box applied");

  const lightEdit = new SplatEdit({
    rgbaBlendMode: SplatEditRgbaBlendMode.ADD_RGBA,
    softEdge: anchors.lightRadius * 0.6,
  });
  const lightSphere = new SplatEditSdf({
    type: SplatEditSdfType.SPHERE,
    color: new THREE.Color(0.2, 0.14, 0.05),
    opacity: 0,
    radius: anchors.lightRadius,
  });
  lightSphere.position.copy(anchors.lightCenter);
  lightEdit.addSdf(lightSphere);
  viewer.scene.add(lightEdit); // global edit (scoping behavior spike)
  console.log("[spike] Additive light sphere applied");

  console.log(
    `[spike] softEdge test enabled (delete=${deleteEdit.softEdge.toFixed(3)}, recolor=${recolorEdit.softEdge.toFixed(3)}, light=${lightEdit.softEdge.toFixed(3)})`
  );
  console.log(
    "[spike] Scoped edits added to splatMesh; additive edit added to scene (global)"
  );

  window.setTimeout(() => {
    if (recolorEdit.parent) {
      recolorEdit.parent.remove(recolorEdit);
    }

    const maybeDisposable = recolorEdit as unknown as { dispose?: () => void };
    if (typeof maybeDisposable.dispose === "function") {
      maybeDisposable.dispose();
    }

    console.log("[spike] Recolor edit removed to verify splat restoration");
  }, 5000);

  // Keep the variable referenced for future wiring; avoids accidental "unused" refactors.
  window.addEventListener("keydown", (event) => {
    if (event.key.toLowerCase() === "l" && lastClickPoint) {
      console.log("[main] Last clicked point:", lastClickPoint.toArray());
    }
  });
}

bootstrap().catch((error) => {
  console.error("[main] Failed to bootstrap viewer", error);
  const info = document.querySelector<HTMLDivElement>("#info");
  if (info) {
    info.textContent = "Failed to load scene. Check console.";
  }
});
