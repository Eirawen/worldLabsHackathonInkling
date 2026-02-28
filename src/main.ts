import * as THREE from "three";
import type { SplatMesh } from "@sparkjsdev/spark";
import { processCommand } from "./agent";
import {
  executeOperations,
  setAssetExtractionHandler,
  undoLastEdit,
} from "./executor";
import {
  addAsset,
  createPlacedAssetMesh,
  ensureDefaultLibraryAsset,
  extractAssetFromDeleteOperation,
  getAssetById,
  listAssets,
} from "./asset-library";
import { generateManifest, getManifestJSON } from "./scene-manifest";
import {
  buildSpatialGrid,
  getCellAtWorldPos,
  gridKey,
  serializeSpatialGridForLLM,
} from "./spatial-index";
import type { SceneManifest, SpatialGrid, WorldCatalog, WorldEdgeConfig, WorldNodeConfig } from "./types";
import { closeWorldHub, initUI, openWorldHub } from "./ui";
import {
  getCurrentSplatMesh,
  getScreenshot,
  getScreenshotCropAroundPoint,
  initViewer,
  loadWorld,
  onSplatClick,
} from "./viewer";
import { loadWorldCatalog } from "./world-catalog";

let currentGrid: SpatialGrid | null = null;
let currentManifest: SceneManifest | null = null;
let lastClickPoint: THREE.Vector3 | null = null;
let currentWorldId: string | null = null;
let currentWorldSceneUrl: string | null = null;
let worldCatalog: WorldCatalog = { nodes: [], edges: [] };
let worldLoading = false;

export function getGrid(): SpatialGrid | null {
  return currentGrid;
}

export function getManifest(): SceneManifest | null {
  return currentManifest;
}

export function getLastClickPoint(): THREE.Vector3 | null {
  return lastClickPoint;
}

function getCurrentWorldId(): string | null {
  return currentWorldId;
}

function listWorlds(): readonly WorldNodeConfig[] {
  return worldCatalog.nodes;
}

function listWorldEdges(): readonly WorldEdgeConfig[] {
  return worldCatalog.edges;
}

async function bootstrap() {
  const canvas = document.querySelector<HTMLCanvasElement>("#canvas");
  const info = document.querySelector<HTMLDivElement>("#info");

  if (!canvas) {
    throw new Error("Missing #canvas element");
  }

  worldCatalog = await loadWorldCatalog();
  const initialNode = resolveInitialNode(worldCatalog);
  info?.replaceChildren(`Initializing renderer...`);

  await initViewer(canvas, initialNode.sceneUrl);
  await ensureDefaultLibraryAsset();
  console.log("[main] Viewer initialized");

  onSplatClick((point) => {
    lastClickPoint = point.clone();
    console.log("[main] Selected point:", point.toArray());

    const activeGrid = currentGrid;
    if (!activeGrid) {
      console.log("[spatial] Click registered before world index is ready");
      return;
    }

    const hitCell = getCellAtWorldPos(activeGrid, point);
    if (hitCell) {
      console.log(
        `[spatial] Click cell ${gridKey(...hitCell.gridPos)} splats=${hitCell.splatCount} density=${hitCell.density.toFixed(2)}`
      );
    } else {
      const gb = activeGrid.worldBounds;
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

  setAssetExtractionHandler((op, parent) => {
    const extractionMesh = resolveSplatMesh(parent, getCurrentSplatMesh());
    const sourceScene =
      currentWorldId && currentWorldSceneUrl
        ? `${currentWorldId}:${currentWorldSceneUrl}`
        : currentWorldSceneUrl ?? currentWorldId ?? "unknown-scene";
    const asset = extractAssetFromDeleteOperation(op, extractionMesh, sourceScene);
    if (!asset) {
      console.log("[main] No asset extracted for current delete operation");
      return;
    }

    addAsset(asset);
    console.log(
      `[main] Asset saved id=${asset.id} label="${asset.label}" splats=${asset.splatCount} source=${sourceScene}`
    );
  });

  initUI({
    processCommand,
    executeOperations,
    undoLastEdit,
    getSplatMesh: () => getCurrentSplatMesh(),
    getScreenshot,
    getScreenshotCropAroundPoint,
    getGrid,
    getManifest,
    getLastClickPoint,
    onSplatClick,
    listAssets,
    getAssetById,
    createPlacedAssetMesh,
    getPlacementParent: () => getCurrentSplatMesh().parent ?? getCurrentSplatMesh(),
    listWorlds,
    listWorldEdges,
    getCurrentWorldId,
    loadWorldById,
    isWorldLoading: () => worldLoading,
  });

  openWorldHub();

  window.addEventListener("keydown", (event) => {
    if (event.key.toLowerCase() === "l" && lastClickPoint) {
      console.log("[main] Last clicked point:", lastClickPoint.toArray());
    }
  });

  async function loadWorldById(worldId: string, keepHubOpen: boolean = false): Promise<void> {
    if (worldLoading) {
      console.log(`[main] Ignoring world swap while another load is running (${worldId})`);
      return;
    }
    const node = worldCatalog.nodes.find((candidate) => candidate.id === worldId);
    if (!node) {
      throw new Error(`Unknown world id: ${worldId}`);
    }

    worldLoading = true;
    info?.replaceChildren(`Loading ${node.label}...`);
    console.log(`[main] Loading world id=${node.id} scene=${node.sceneUrl}`);

    try {
      const world = await loadWorld(node.sceneUrl);
      currentWorldId = node.id;
      currentWorldSceneUrl = node.sceneUrl;
      lastClickPoint = null;

      const spatialGrid = buildSpatialGrid(world.splatMesh);
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

      info?.replaceChildren(`Loaded ${node.label}`);
      if (!keepHubOpen) {
        closeWorldHub();
      }
      console.log(`[main] Active world=${node.id}`);
    } catch (error) {
      console.error(`[main] Failed to load world ${node.id}`, error);
      info?.replaceChildren(`Failed to load ${node.label}`);
      openWorldHub();
      throw error;
    } finally {
      worldLoading = false;
    }
  }
}

function resolveInitialNode(catalog: WorldCatalog): WorldNodeConfig {
  if (catalog.nodes.length === 0) {
    throw new Error("World catalog has no loadable nodes");
  }
  if (catalog.defaultWorldId) {
    const explicit = catalog.nodes.find((node) => node.id === catalog.defaultWorldId);
    if (explicit) {
      return explicit;
    }
  }
  return catalog.nodes[0];
}

function resolveSplatMesh(parent: THREE.Object3D, fallback: SplatMesh): SplatMesh {
  if (looksLikeSplatMesh(parent)) {
    return parent;
  }

  let current: THREE.Object3D | null = parent.parent;
  while (current) {
    if (looksLikeSplatMesh(current)) {
      return current;
    }
    current = current.parent;
  }

  return fallback;
}

function looksLikeSplatMesh(obj: unknown): obj is SplatMesh {
  return (
    typeof obj === "object" &&
    obj !== null &&
    typeof (obj as SplatMesh).forEachSplat === "function" &&
    typeof (obj as SplatMesh).getBoundingBox === "function"
  );
}

bootstrap().catch((error) => {
  console.error("[main] Failed to bootstrap viewer", error);
  const info = document.querySelector<HTMLDivElement>("#info");
  if (info) {
    info.textContent = "Failed to load scene. Check console.";
  }
});
