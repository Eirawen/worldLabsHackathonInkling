import type { SplatMesh } from "@sparkjsdev/spark";
import type * as THREE from "three";
import {
  buildClickContext,
  setProviderPreference,
  setSecondaryScreenshotForNextCommand,
  type processCommand as processCommandFn,
} from "./agent";
import { buildLocalSelection, formatSelectionHint } from "./click-selection";
import type {
  executeOperations as executeOperationsFn,
  undoLastEdit as undoLastEditFn,
} from "./executor";
import { getManifestJSON } from "./scene-manifest";
import { getCellAtWorldPos, getNeighborCells } from "./spatial-index";
import type {
  AssetEntry,
  SceneManifest,
  SpatialGrid,
  WorldEdgeConfig,
  WorldNodeConfig,
} from "./types";

type ProcessCommand = typeof processCommandFn;
type ExecuteOperations = typeof executeOperationsFn;
type UndoLastEdit = typeof undoLastEditFn;

export interface UIDependencies {
  processCommand: ProcessCommand;
  executeOperations: ExecuteOperations;
  undoLastEdit: UndoLastEdit;
  getSplatMesh: () => SplatMesh;
  getScreenshot: () => string;
  getScreenshotCropAroundPoint?: (point: THREE.Vector3, sizePx?: number) => string | null;
  getGrid: () => SpatialGrid | null;
  getManifest: () => SceneManifest | null;
  getLastClickPoint: () => THREE.Vector3 | null;
  onSplatClick?: (callback: (point: THREE.Vector3) => void) => () => void;
  listAssets?: () => readonly AssetEntry[];
  getAssetById?: (id: string) => AssetEntry | undefined;
  createPlacedAssetMesh?: (asset: AssetEntry, worldPos: THREE.Vector3) => SplatMesh;
  getPlacementParent?: () => THREE.Object3D;
  listWorlds: () => readonly WorldNodeConfig[];
  listWorldEdges: () => readonly WorldEdgeConfig[];
  getCurrentWorldId: () => string | null;
  loadWorldById: (worldId: string) => Promise<void>;
  isWorldLoading?: () => boolean;
}

let toastContainer: HTMLDivElement | null = null;
let worldHub: HTMLDivElement | null = null;
let worldHubGraph: HTMLDivElement | null = null;
let worldHubList: HTMLDivElement | null = null;
let worldHubOpen = false;
let initialized = false;

const ENABLE_CLICK_SELECTION_HINTS =
  String(import.meta.env.VITE_ENABLE_CLICK_SELECTION_HINTS ?? "true").toLowerCase() !==
  "false";
const CROP_SIZE_PX = 320;
const MIN_SELECTION_CONFIDENCE = 0.2;
const DEFAULT_PROVIDER =
  String(import.meta.env.VITE_DEFAULT_LLM_PROVIDER ?? "gemini").toLowerCase() === "openai"
    ? "openai"
    : "gemini";

export function initUI(deps: UIDependencies): void {
  if (initialized) {
    console.log("[ui] initUI skipped (already initialized)");
    return;
  }
  initialized = true;
  console.log("[ui] Initializing chat + library UI");
  console.log(
    `[ui] Selection config: hintsEnabled=${ENABLE_CLICK_SELECTION_HINTS} minConfidence=${MIN_SELECTION_CONFIDENCE.toFixed(2)} cropPx=${CROP_SIZE_PX}`
  );

  const container = document.createElement("div");
  container.id = "muse-chat-container";

  const messages = document.createElement("div");
  messages.id = "muse-messages";

  const inputRow = document.createElement("div");
  inputRow.id = "muse-input-row";

  const input = document.createElement("input");
  input.id = "muse-input";
  input.type = "text";
  input.placeholder = "Talk to this world...";
  input.autocomplete = "off";

  const sendButton = document.createElement("button");
  sendButton.id = "muse-send-btn";
  sendButton.type = "button";
  sendButton.textContent = "→";

  const undoButton = document.createElement("button");
  undoButton.id = "muse-undo-btn";
  undoButton.type = "button";
  undoButton.textContent = "↩";

  const providerButton = document.createElement("button");
  providerButton.id = "muse-provider-btn";
  providerButton.type = "button";
  providerButton.textContent = "Gemini";

  const status = document.createElement("div");
  status.id = "muse-status";

  inputRow.append(input, sendButton, undoButton, providerButton);
  container.append(messages, inputRow, status);
  document.body.append(container);

  const library = document.createElement("aside");
  library.id = "muse-library";

  const libraryHeader = document.createElement("div");
  libraryHeader.id = "muse-library-header";
  libraryHeader.textContent = "Asset Library";

  const libraryStatus = document.createElement("div");
  libraryStatus.id = "muse-library-status";

  const libraryList = document.createElement("div");
  libraryList.id = "muse-library-list";

  library.append(libraryHeader, libraryStatus, libraryList);
  document.body.append(library);

  toastContainer = document.createElement("div");
  toastContainer.id = "muse-toast-container";
  document.body.append(toastContainer);

  buildWorldHub(deps);
  renderWorldHub(deps);

  let selectedAssetId: string | null = null;
  let provider: "gemini" | "openai" = DEFAULT_PROVIDER;
  let commandBusy = false;
  setProviderPreference(provider);
  providerButton.textContent = provider === "gemini" ? "Gemini" : "OpenAI";

  setStatus(status, "Click an object, then type a command");
  setLibraryStatus(libraryStatus, "No asset selected");
  appendMessage(
    messages,
    "system",
    "Click an object, then type a command. Try: 'remove this' or 'add warm lighting'"
  );

  const setBusy = (busy: boolean) => {
    commandBusy = busy;
    const worldLoading = deps.isWorldLoading?.() ?? false;
    const disableInput = busy || worldLoading;
    input.disabled = disableInput;
    sendButton.disabled = disableInput;
    undoButton.disabled = busy;
    providerButton.disabled = false;
  };

  const refreshBusyState = () => {
    setBusy(commandBusy);
  };

  const renderLibrary = () => {
    libraryList.replaceChildren();

    if (
      !deps.listAssets ||
      !deps.getAssetById ||
      !deps.createPlacedAssetMesh ||
      !deps.getPlacementParent
    ) {
      const disabled = document.createElement("div");
      disabled.className = "muse-library-empty";
      disabled.textContent = "Asset placement unavailable.";
      libraryList.append(disabled);
      return;
    }

    const assets = deps.listAssets();
    if (assets.length === 0) {
      const empty = document.createElement("div");
      empty.className = "muse-library-empty";
      empty.textContent = "No extracted assets yet.";
      libraryList.append(empty);
      return;
    }

    for (const asset of assets) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "muse-asset-item";
      if (asset.id === selectedAssetId) {
        item.classList.add("active");
      }

      const label = document.createElement("div");
      label.className = "muse-asset-label";
      label.textContent = asset.label;

      const meta = document.createElement("div");
      meta.className = "muse-asset-meta";
      meta.textContent = `${asset.splatCount.toLocaleString()} splats`;

      item.append(label, meta);
      item.addEventListener("click", () => {
        const wasSelected = selectedAssetId === asset.id;
        selectedAssetId = wasSelected ? null : asset.id;
        if (wasSelected) {
          showToast("Placement canceled", 1500);
          setLibraryStatus(libraryStatus, "No asset selected");
        } else {
          showToast(`Placement armed: ${asset.label}`);
          setLibraryStatus(libraryStatus, `Placement mode: ${asset.label}`);
        }
        renderLibrary();
      });

      libraryList.append(item);
    }
  };

  renderLibrary();

  if (deps.onSplatClick) {
    deps.onSplatClick((point) => {
      if (!selectedAssetId) {
        return;
      }
      if (worldHubOpen) {
        showToast("Close world hub to place assets", 1700);
        return;
      }
      if (!deps.getAssetById || !deps.createPlacedAssetMesh || !deps.getPlacementParent) {
        showToast("Placement APIs unavailable", 1800);
        selectedAssetId = null;
        setLibraryStatus(libraryStatus, "No asset selected");
        renderLibrary();
        return;
      }

      const asset = deps.getAssetById(selectedAssetId);
      if (!asset) {
        showToast("Selected asset no longer exists", 1800);
        selectedAssetId = null;
        setLibraryStatus(libraryStatus, "No asset selected");
        renderLibrary();
        return;
      }

      try {
        const mesh = deps.createPlacedAssetMesh(asset, point.clone());
        deps.getPlacementParent().add(mesh);
        appendMessage(messages, "assistant", `Placed asset: ${asset.label}`);
        showToast(`Placed: ${asset.label}`);
      } catch (error) {
        console.error("[ui] Failed to place asset", error);
        showToast("Placement failed", 2000);
      } finally {
        selectedAssetId = null;
        setLibraryStatus(libraryStatus, "No asset selected");
        renderLibrary();
      }
    });
  }

  const handleSend = async () => {
    if (worldHubOpen) {
      showToast("Select or close world hub first", 1600);
      return;
    }
    if (deps.isWorldLoading?.()) {
      showToast("World is still loading", 1600);
      return;
    }

    const command = input.value.trim();
    if (!command) {
      return;
    }

    const startedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
    const assetsBefore = deps.listAssets?.().length ?? 0;
    appendMessage(messages, "user", command);
    setBusy(true);
    setStatus(status, "Thinking...");
    console.log(`[ui] Processing command="${command}"`);

    try {
      const clickPoint = deps.getLastClickPoint();
      const grid = deps.getGrid();
      const manifest = deps.getManifest();
      const splatMesh = deps.getSplatMesh();
      const screenshot = normalizeScreenshotDataUrl(deps.getScreenshot());
      const screenshotCrop =
        clickPoint && deps.getScreenshotCropAroundPoint
          ? normalizeScreenshotDataUrl(
              deps.getScreenshotCropAroundPoint(clickPoint, CROP_SIZE_PX) ?? ""
            )
          : "";
      const apiKey = readGeminiApiKey();

      const voxelContext = buildVoxelContext(grid, clickPoint);
      const manifestSummary = manifest ? getManifestJSON(manifest) : null;
      setSecondaryScreenshotForNextCommand(screenshotCrop || null);

      const operations = await deps.processCommand(
        command,
        clickPoint,
        voxelContext,
        manifestSummary,
        screenshot,
        apiKey
      );

      deps.executeOperations(operations, splatMesh);
      appendMessage(
        messages,
        "assistant",
        `Applied ${operations.length} operation${operations.length === 1 ? "" : "s"}.`
      );

      for (const op of operations) {
        const summary =
          op.assetLabel ?? `${op.shapes.length} shape${op.shapes.length === 1 ? "" : "s"}`;
        showToast(`✓ ${op.action}: ${summary}`);
      }

      renderLibrary();
      const assetsAfter = deps.listAssets?.().length ?? assetsBefore;
      const createdCount = Math.max(0, assetsAfter - assetsBefore);
      if (createdCount > 0) {
        showToast(`Saved ${createdCount} asset${createdCount === 1 ? "" : "s"}`);
      }

      setStatus(status, "Ready");
      input.value = "";
      const elapsedMs =
        (typeof performance !== "undefined" ? performance.now() : Date.now()) - startedAt;
      console.log(`[ui] Command complete in ${elapsedMs.toFixed(1)}ms`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[ui] Command failed", error);
      appendMessage(messages, "error", `Error: ${message}`);
      showToast("Command failed", 2500);
      setStatus(status, "Ready");
    } finally {
      setBusy(false);
    }
  };

  sendButton.addEventListener("click", () => {
    void handleSend();
  });

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void handleSend();
    }
  });

  undoButton.addEventListener("click", () => {
    const undone = deps.undoLastEdit();
    if (undone) {
      appendMessage(messages, "system", "Undid last edit.");
      showToast("↩ Undid last edit");
    } else {
      showToast("No edits to undo", 1800);
    }
  });

  providerButton.addEventListener("click", () => {
    provider = provider === "gemini" ? "openai" : "gemini";
    setProviderPreference(provider);
    providerButton.textContent = provider === "gemini" ? "Gemini" : "OpenAI";
    showToast(`Provider: ${providerButton.textContent}`, 1400);
  });

  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && selectedAssetId) {
      selectedAssetId = null;
      setLibraryStatus(libraryStatus, "No asset selected");
      renderLibrary();
      showToast("Placement canceled", 1500);
      return;
    }

    if (event.key === "Escape") {
      if (document.activeElement === input) {
        input.blur();
        setStatus(status, "Ready");
        return;
      }
      if (worldHubOpen) {
        closeWorldHub();
        setStatus(status, "Ready");
      } else {
        openWorldHub();
        renderWorldHub(deps);
        setStatus(status, "Select a world");
      }
      refreshBusyState();
      return;
    }

    if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "z") {
      return;
    }
    event.preventDefault();
    const undone = deps.undoLastEdit();
    if (undone) {
      appendMessage(messages, "system", "Undid last edit.");
      showToast("↩ Undid last edit");
    } else {
      showToast("No edits to undo", 1800);
    }
  });

  worldHub?.addEventListener("click", (event) => {
    if (event.target === worldHub) {
      closeWorldHub();
      refreshBusyState();
    }
  });

  if (deps.isWorldLoading) {
    window.setInterval(() => {
      refreshBusyState();
    }, 250);
  }

}

export function showToast(message: string, duration: number = 3000): void {
  if (!toastContainer) {
    return;
  }

  const toast = document.createElement("div");
  toast.className = "muse-toast";
  toast.textContent = message;
  toastContainer.append(toast);

  const fadeDelay = Math.max(200, duration - 250);
  window.setTimeout(() => {
    toast.classList.add("fade-out");
  }, fadeDelay);

  window.setTimeout(() => {
    toast.remove();
  }, duration);
}

export function openWorldHub(): void {
  if (!worldHub) {
    return;
  }
  worldHub.classList.remove("hidden");
  worldHubOpen = true;
}

export function closeWorldHub(): void {
  if (!worldHub) {
    return;
  }
  worldHub.classList.add("hidden");
  worldHubOpen = false;
}

function buildWorldHub(deps: UIDependencies): void {
  worldHub = document.createElement("div");
  worldHub.id = "muse-world-hub";
  worldHub.classList.add("hidden");

  const panel = document.createElement("div");
  panel.id = "muse-world-panel";

  const title = document.createElement("h2");
  title.id = "muse-world-title";
  title.textContent = "Choose A World";

  const subtitle = document.createElement("p");
  subtitle.id = "muse-world-subtitle";
  subtitle.textContent = "Press Esc anytime to return to this hub.";

  worldHubGraph = document.createElement("div");
  worldHubGraph.id = "muse-world-graph";

  worldHubList = document.createElement("div");
  worldHubList.id = "muse-world-list";

  panel.append(title, subtitle, worldHubGraph, worldHubList);
  worldHub.append(panel);
  document.body.append(worldHub);

  worldHub.addEventListener("click", (event) => {
    const target = event.target as HTMLElement | null;
    const worldButton = target?.closest<HTMLElement>("[data-world-id]");
    const worldId = worldButton?.dataset.worldId;
    if (!worldId) {
      return;
    }

    void handleWorldSelect(deps, worldId);
  });
}

function renderWorldHub(deps: UIDependencies): void {
  if (!worldHubGraph || !worldHubList) {
    return;
  }
  worldHubGraph.replaceChildren();
  worldHubList.replaceChildren();

  const worlds = deps.listWorlds();
  const edges = deps.listWorldEdges();
  const currentWorldId = deps.getCurrentWorldId();
  const nodeById = new Map(worlds.map((world) => [world.id, world]));

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "muse-world-edges");
  svg.setAttribute("viewBox", "0 0 100 100");
  svg.setAttribute("preserveAspectRatio", "none");

  for (const edge of edges) {
    const from = nodeById.get(edge.from);
    const to = nodeById.get(edge.to);
    if (!from || !to) {
      continue;
    }
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", `${from.position[0] * 100}`);
    line.setAttribute("y1", `${from.position[1] * 100}`);
    line.setAttribute("x2", `${to.position[0] * 100}`);
    line.setAttribute("y2", `${to.position[1] * 100}`);
    svg.append(line);
  }
  worldHubGraph.append(svg);

  for (const world of worlds) {
    const node = document.createElement("button");
    node.type = "button";
    node.className = "muse-world-node";
    if (world.id === currentWorldId) {
      node.classList.add("active");
    }
    node.dataset.worldId = world.id;
    node.style.left = `${world.position[0] * 100}%`;
    node.style.top = `${world.position[1] * 100}%`;
    node.textContent = world.label;
    worldHubGraph.append(node);

    const row = document.createElement("button");
    row.type = "button";
    row.className = "muse-world-list-item";
    if (world.id === currentWorldId) {
      row.classList.add("active");
    }
    row.dataset.worldId = world.id;
    row.innerHTML = `<strong>${escapeHtml(world.label)}</strong><span>${escapeHtml(
      world.description ?? world.sceneUrl
    )}</span>`;
    worldHubList.append(row);
  }
}

async function handleWorldSelect(deps: UIDependencies, worldId: string): Promise<void> {
  const world = deps.listWorlds().find((entry) => entry.id === worldId);
  if (!world) {
    showToast("Unknown world", 1600);
    return;
  }

  if (deps.isWorldLoading?.()) {
    showToast("World is already loading", 1600);
    return;
  }

  showToast(`Loading ${world.label}...`, 1300);
  try {
    await deps.loadWorldById(worldId);
    renderWorldHub(deps);
    closeWorldHub();
    showToast(`Loaded ${world.label}`);
  } catch (error) {
    console.error("[ui] Failed to load world", error);
    showToast(`Failed to load ${world.label}`, 2200);
    openWorldHub();
  }
}

function appendMessage(
  container: HTMLDivElement,
  kind: "user" | "assistant" | "system" | "error",
  text: string
): void {
  const el = document.createElement("div");
  el.className = `muse-msg muse-msg-${kind}`;
  el.textContent = text;
  container.append(el);
  container.scrollTop = container.scrollHeight;

  const maxMessages = 14;
  while (container.children.length > maxMessages) {
    container.firstElementChild?.remove();
  }
}

function setStatus(statusEl: HTMLDivElement, text: string): void {
  statusEl.textContent = text;
}

function setLibraryStatus(statusEl: HTMLDivElement, text: string): void {
  statusEl.textContent = text;
}

function buildVoxelContext(grid: SpatialGrid | null, clickPoint: THREE.Vector3 | null): string | null {
  if (!grid || !clickPoint) {
    return null;
  }

  const cell = getCellAtWorldPos(grid, clickPoint);
  const neighbors = cell ? getNeighborCells(grid, cell, 1) : [];
  const baseContext = buildClickContext(clickPoint, cell, neighbors);

  if (!ENABLE_CLICK_SELECTION_HINTS) {
    return baseContext;
  }

  const selection = buildLocalSelection(grid, clickPoint);
  if (!selection || selection.confidence < MIN_SELECTION_CONFIDENCE) {
    return baseContext;
  }

  const hint = formatSelectionHint(selection);
  return `${baseContext}\n\n${hint}`;
}

function normalizeScreenshotDataUrl(dataUrl: string): string {
  const trimmed = dataUrl.trim();
  if (!trimmed) {
    return trimmed;
  }
  const match = trimmed.match(/^data:image\/(?:png|jpeg|jpg|webp);base64,(.+)$/i);
  return match ? match[1] : trimmed;
}

function readGeminiApiKey(): string {
  const googleKey = String(import.meta.env.VITE_GOOGLE_API_KEY ?? "").trim();
  if (googleKey) {
    return googleKey;
  }
  return String(import.meta.env.VITE_GEMINI_API_KEY ?? "").trim();
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (token) => {
    if (token === "&") return "&amp;";
    if (token === "<") return "&lt;";
    if (token === ">") return "&gt;";
    if (token === '"') return "&quot;";
    return "&#39;";
  });
}
