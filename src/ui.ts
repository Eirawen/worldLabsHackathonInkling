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
import type { EditOperation, SceneManifest, SpatialGrid } from "./types";

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
}

let toastContainer: HTMLDivElement | null = null;
let initialized = false;
const ENABLE_CLICK_SELECTION_HINTS =
  String(import.meta.env.VITE_ENABLE_CLICK_SELECTION_HINTS ?? "true").toLowerCase() !==
  "false";
const CROP_SIZE_PX = 320;
const MIN_SELECTION_CONFIDENCE = 0.35;
const ENABLE_FLOOR_PROTECTION =
  String(import.meta.env.VITE_ENABLE_FLOOR_PROTECTION ?? "true").toLowerCase() !==
  "false";
const FLOOR_BOTTOM_QUANTILE_REJECT = clampNumber(
  Number(import.meta.env.VITE_FLOOR_BOTTOM_QUANTILE_REJECT ?? "0.2"),
  0,
  0.95,
  0.2
);
const FLOOR_UPWARD_BIAS_FACTOR = clampNumber(
  Number(import.meta.env.VITE_FLOOR_UPWARD_BIAS_FACTOR ?? "0.08"),
  0,
  0.5,
  0.08
);

export function initUI(deps: UIDependencies): void {
  if (initialized) {
    console.log("[ui] initUI skipped (already initialized)");
    return;
  }
  initialized = true;
  console.log("[ui] Initializing chat UI");
  console.log(
    `[ui] Selection config: hintsEnabled=${ENABLE_CLICK_SELECTION_HINTS} floorProtection=${ENABLE_FLOOR_PROTECTION} floorQuantile=${FLOOR_BOTTOM_QUANTILE_REJECT.toFixed(3)} floorUpBias=${FLOOR_UPWARD_BIAS_FACTOR.toFixed(3)}`
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

  toastContainer = document.createElement("div");
  toastContainer.id = "muse-toast-container";
  document.body.append(toastContainer);

  setStatus(status, "Click an object, then type a command");
  appendMessage(
    messages,
    "system",
    "Click an object, then type a command. Try: 'remove this' or 'add warm lighting'"
  );

  const setBusy = (busy: boolean) => {
    console.log(`[ui] setBusy(${busy})`);
    input.disabled = busy;
    sendButton.disabled = busy;
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
      const apiKey = String(import.meta.env.VITE_GEMINI_API_KEY ?? "").trim();

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

  const selection = buildLocalSelection(grid, clickPoint, {
    enableFloorProtection: ENABLE_FLOOR_PROTECTION,
    bottomQuantileReject: FLOOR_BOTTOM_QUANTILE_REJECT,
    minProtectedCells: 2,
    upwardCenterBiasFactor: FLOOR_UPWARD_BIAS_FACTOR,
  });
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

function formatVec3OrNull(vec: THREE.Vector3 | null): string {
  if (!vec) {
    return "null";
  }
  return `[${vec.x.toFixed(3)}, ${vec.y.toFixed(3)}, ${vec.z.toFixed(3)}]`;
}

function summarizeOperations(
  operations: EditOperation[]
): string {
  if (operations.length === 0) {
    return "none";
  }
  return operations
    .map((op, index) => `${index + 1}:${op.action}[${op.shapes.map((s) => s.type).join(",")}]`)
    .join(" | ");
}

function clampNumber(
  value: number,
  min: number,
  max: number,
  fallback: number
): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, value));
}
