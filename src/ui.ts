import type { SplatMesh } from "@sparkjsdev/spark";
import type * as THREE from "three";
import {
  buildClickContext,
  setSecondaryScreenshotForNextCommand,
  type processCommand as processCommandFn,
} from "./agent";
import { buildLocalSelection, formatSelectionHint } from "./click-selection";
import type { executeOperations as executeOperationsFn, undoLastEdit as undoLastEditFn } from "./executor";
import { getManifestJSON } from "./scene-manifest";
import { getCellAtWorldPos, getNeighborCells } from "./spatial-index";
import type { AssetEntry, SceneManifest, SpatialGrid } from "./types";

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
}

let toastContainer: HTMLDivElement | null = null;
let initialized = false;
const ENABLE_CLICK_SELECTION_HINTS =
  String(import.meta.env.VITE_ENABLE_CLICK_SELECTION_HINTS ?? "true").toLowerCase() !==
  "false";
const CROP_SIZE_PX = 320;
const MIN_SELECTION_CONFIDENCE = 0.35;

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

  const status = document.createElement("div");
  status.id = "muse-status";

  inputRow.append(input, sendButton, undoButton);
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

  let selectedAssetId: string | null = null;

  setStatus(status, "Click an object, then type a command");
  setLibraryStatus(libraryStatus, "No asset selected");
  appendMessage(
    messages,
    "system",
    "Click an object, then type a command. Try: 'remove this' or 'add warm lighting'"
  );

  const renderLibrary = () => {
    libraryList.replaceChildren();

    if (!deps.listAssets || !deps.getAssetById || !deps.createPlacedAssetMesh || !deps.getPlacementParent) {
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

  const setBusy = (busy: boolean) => {
    console.log(`[ui] setBusy(${busy})`);
    input.disabled = busy;
    sendButton.disabled = busy;
    undoButton.disabled = busy;
    if (!busy) {
      input.focus();
    }
  };

  const handleSend = async () => {
    const command = input.value.trim();
    if (!command) {
      console.log("[ui] Ignoring empty command");
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

      console.log(
        `[ui] Context: click=${formatVec3OrNull(clickPoint)} grid=${grid ? "ready" : "null"} manifest=${manifest ? "ready" : "null"} screenshotBytes=${screenshot.length} cropBytes=${screenshotCrop.length} apiKeyPresent=${apiKey.length > 0}`
      );

      const voxelContext = buildVoxelContext(grid, clickPoint);
      const manifestSummary = manifest ? getManifestJSON(manifest) : null;
      setSecondaryScreenshotForNextCommand(screenshotCrop || null);
      console.log(
        `[ui] Prompt payload: voxelContextChars=${voxelContext?.length ?? 0} manifestChars=${manifestSummary?.length ?? 0}`
      );

      const operations = await deps.processCommand(
        command,
        clickPoint,
        voxelContext,
        manifestSummary,
        screenshot,
        apiKey
      );
      console.log(`[ui] Agent returned ${operations.length} operation(s)`);
      console.log(`[ui] Operation summary: ${summarizeOperations(operations)}`);

      deps.executeOperations(operations, splatMesh);
      console.log("[ui] Executor applied operations");
      appendMessage(
        messages,
        "assistant",
        `Applied ${operations.length} operation${operations.length === 1 ? "" : "s"}.`
      );

      for (const op of operations) {
        const summary = op.assetLabel ?? `${op.shapes.length} shape${op.shapes.length === 1 ? "" : "s"}`;
        showToast(`✓ ${op.action}: ${summary}`);
      }

      renderLibrary();
      const assetsAfter = deps.listAssets?.().length ?? assetsBefore;
      const createdCount = Math.max(0, assetsAfter - assetsBefore);
      if (createdCount > 0) {
        showToast(`Saved ${createdCount} asset${createdCount === 1 ? "" : "s"}`);
        appendMessage(
          messages,
          "system",
          `Saved ${createdCount} asset${createdCount === 1 ? "" : "s"} to library.`
        );
      }

      setStatus(status, "Ready");
      input.value = "";
      const elapsedMs = (typeof performance !== "undefined" ? performance.now() : Date.now()) - startedAt;
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
    console.log("[ui] Undo button clicked");
    const undone = deps.undoLastEdit();
    if (undone) {
      appendMessage(messages, "system", "Undid last edit.");
      showToast("↩ Undid last edit");
    } else {
      showToast("No edits to undo", 1800);
    }
  });

  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && selectedAssetId) {
      selectedAssetId = null;
      setLibraryStatus(libraryStatus, "No asset selected");
      renderLibrary();
      showToast("Placement canceled", 1500);
      return;
    }

    if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "z") {
      return;
    }
    console.log("[ui] Undo shortcut triggered");
    event.preventDefault();
    const undone = deps.undoLastEdit();
    if (undone) {
      appendMessage(messages, "system", "Undid last edit.");
      showToast("↩ Undid last edit");
    } else {
      showToast("No edits to undo", 1800);
    }
  });

  input.focus();
}

export function showToast(message: string, duration: number = 3000): void {
  if (!toastContainer) {
    console.warn("[ui] showToast called before toast container exists");
    return;
  }
  console.log(`[ui] Toast: "${message}" (${duration}ms)`);

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

function buildVoxelContext(
  grid: SpatialGrid | null,
  clickPoint: THREE.Vector3 | null
): string | null {
  if (!grid || !clickPoint) {
    console.log(
      `[ui] buildVoxelContext skipped: grid=${Boolean(grid)} clickPoint=${Boolean(clickPoint)}`
    );
    return null;
  }

  const cell = getCellAtWorldPos(grid, clickPoint);
  const neighbors = cell ? getNeighborCells(grid, cell, 1) : [];
  console.log(
    `[ui] buildVoxelContext: cell=${cell ? cell.gridPos.join(",") : "none"} neighbors=${neighbors.length}`
  );
  const baseContext = buildClickContext(clickPoint, cell, neighbors);

  if (!ENABLE_CLICK_SELECTION_HINTS) {
    console.log("[ui] Deterministic selection hints disabled via feature flag");
    return baseContext;
  }

  const selection = buildLocalSelection(grid, clickPoint);
  if (!selection) {
    console.log("[ui] Deterministic selection unavailable; using base context");
    return baseContext;
  }
  if (selection.confidence < MIN_SELECTION_CONFIDENCE) {
    console.log(
      `[ui] Deterministic selection confidence too low (${selection.confidence.toFixed(3)}); fallback to base context`
    );
    return baseContext;
  }

  const hint = formatSelectionHint(selection);
  console.log(
    `[ui] Deterministic selection included confidence=${selection.confidence.toFixed(3)} cells=${selection.clusterCellKeys.length}`
  );
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

function formatVec3OrNull(vec: THREE.Vector3 | null): string {
  if (!vec) {
    return "null";
  }
  return `[${vec.x.toFixed(3)}, ${vec.y.toFixed(3)}, ${vec.z.toFixed(3)}]`;
}

function summarizeOperations(
  operations: Array<{ action: string; shapes: Array<{ type: string }> }>
): string {
  if (operations.length === 0) {
    return "none";
  }
  return operations
    .map((op, index) => `${index + 1}:${op.action}[${op.shapes.map((s) => s.type).join(",")}]`)
    .join(" | ");
}
