import * as THREE from "three";
import { processCommand } from "./agent";
import { executeOperations, undoLastEdit } from "./executor";
import { generateManifest, getManifestJSON } from "./scene-manifest";
import {
  buildSpatialGrid,
  getCellAtWorldPos,
  gridKey,
  serializeSpatialGridForLLM,
} from "./spatial-index";
import type { SceneManifest, SpatialGrid } from "./types";
import { initUI } from "./ui";
import {
  getScreenshot,
  initViewer,
  onSplatClick,
} from "./viewer";

const DEFAULT_SCENE_FILE = "elegant_library_with_fireplace_500k.spz";

let currentGrid: SpatialGrid | null = null;
let currentManifest: SceneManifest | null = null;
let lastClickPoint: THREE.Vector3 | null = null;

export function getGrid(): SpatialGrid | null {
  return currentGrid;
}

export function getManifest(): SceneManifest | null {
  return currentManifest;
}

export function getLastClickPoint(): THREE.Vector3 | null {
  return lastClickPoint;
}

async function bootstrap() {
  const canvas = document.querySelector<HTMLCanvasElement>("#canvas");
  const info = document.querySelector<HTMLDivElement>("#info");

  if (!canvas) {
    throw new Error("Missing #canvas element");
  }

  const sceneUrl = `/scenes/${DEFAULT_SCENE_FILE}`;
  info?.replaceChildren(`Loading ${DEFAULT_SCENE_FILE}...`);
  console.log(`[main] bootstrap start scene=${sceneUrl}`);

  const viewer = await initViewer(canvas, sceneUrl);

  info?.replaceChildren(`Loaded ${DEFAULT_SCENE_FILE}`);
  console.log("[main] Viewer initialized", {
    cameraPos: viewer.camera.position.toArray(),
    sceneChildren: viewer.scene.children.length,
  });

  const spatialGrid = buildSpatialGrid(viewer.splatMesh);
  currentGrid = spatialGrid;
  const spatialJson = serializeSpatialGridForLLM(spatialGrid);
  console.log(
    `[spatial] Grid ready: occupied=${spatialGrid.cells.size}, serializedBytes=${spatialJson.length}`
  );

  const manifest = generateManifest(spatialGrid);
  currentManifest = manifest;
  const manifestJson = getManifestJSON(manifest);
  console.log(`[main] Manifest: ${manifest.description}`);
  console.log(
    `[main] Manifest regions=${manifest.regions.length}, serializedBytes=${manifestJson.length}`
  );

  onSplatClick((point) => {
    lastClickPoint = point.clone();
    console.log("[main] Selected point:", point.toArray());

    const hitCell = getCellAtWorldPos(spatialGrid, point);
    if (hitCell) {
      console.log(
        `[spatial] Click cell ${gridKey(...hitCell.gridPos)} splats=${hitCell.splatCount} density=${hitCell.density.toFixed(2)}`
      );
    } else {
      const gb = spatialGrid.worldBounds;
      const dy =
        point.y < gb.min.y
          ? gb.min.y - point.y
          : point.y > gb.max.y
            ? point.y - gb.max.y
            : 0;
      console.log(
        `[spatial] No occupied cell near click (y=${point.y.toFixed(3)}, grid y=[${gb.min.y.toFixed(3)}..${gb.max.y.toFixed(3)}], gap=${dy.toFixed(3)})`
      );
    }
  });
  console.log("[main] Splat click listener ready");

  initUI({
    processCommand,
    executeOperations,
    undoLastEdit,
    getSplatMesh: () => viewer.splatMesh,
    getScreenshot,
    getGrid,
    getManifest,
    getLastClickPoint,
  });
  console.log("[main] UI initialized (classic mode)");

  window.addEventListener("keydown", (event) => {
    if (event.key.toLowerCase() === "l" && lastClickPoint) {
      console.log("[main] Last clicked point:", lastClickPoint.toArray());
    }
  });
  console.log("[main] bootstrap complete");
}

bootstrap().catch((error) => {
  console.error("[main] Failed to bootstrap viewer", error);
  const info = document.querySelector<HTMLDivElement>("#info");
  if (info) {
    info.textContent = "Failed to load scene. Check console.";
  }
});
