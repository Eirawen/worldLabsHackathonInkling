import type { SplatMesh } from "@sparkjsdev/spark";
import type * as THREE from "three";
import { buildClickContext, type processCommand as processCommandFn } from "./agent";
import type { executeOperations as executeOperationsFn, undoLastEdit as undoLastEditFn } from "./executor";
import { getManifestJSON } from "./scene-manifest";
import { getCellAtWorldPos, getNeighborCells } from "./spatial-index";
import type { SceneManifest, SpatialGrid } from "./types";

type ProcessCommand = typeof processCommandFn;
type ExecuteOperations = typeof executeOperationsFn;
type UndoLastEdit = typeof undoLastEditFn;

export interface UIDependencies {
  processCommand: ProcessCommand;
  executeOperations: ExecuteOperations;
  undoLastEdit: UndoLastEdit;
  getSplatMesh: () => SplatMesh;
  getScreenshot: () => string;
  getGrid: () => SpatialGrid | null;
  getManifest: () => SceneManifest | null;
  getLastClickPoint: () => THREE.Vector3 | null;
}

let toastContainer: HTMLDivElement | null = null;
let initialized = false;

export function initUI(deps: UIDependencies): void {
  if (initialized) {
    return;
  }
  initialized = true;

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
    input.disabled = busy;
    sendButton.disabled = busy;
    if (!busy) {
      input.focus();
    }
  };

  const handleSend = async () => {
    const command = input.value.trim();
    if (!command) {
      return;
    }

    appendMessage(messages, "user", command);
    setBusy(true);
    setStatus(status, "Thinking...");

    try {
      const clickPoint = deps.getLastClickPoint();
      const grid = deps.getGrid();
      const manifest = deps.getManifest();
      const splatMesh = deps.getSplatMesh();
      const screenshot = normalizeScreenshotDataUrl(deps.getScreenshot());
      const apiKey = String(import.meta.env.VITE_GEMINI_API_KEY ?? "").trim();

      const voxelContext = buildVoxelContext(grid, clickPoint);
      const manifestSummary = manifest ? getManifestJSON(manifest) : null;

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
        const summary = op.assetLabel ?? `${op.shapes.length} shape${op.shapes.length === 1 ? "" : "s"}`;
        showToast(`✓ ${op.action}: ${summary}`);
      }

      setStatus(status, "Ready");
      input.value = "";
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

  window.addEventListener("keydown", (event) => {
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

  input.focus();
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
    return null;
  }

  const cell = getCellAtWorldPos(grid, clickPoint);
  const neighbors = cell ? getNeighborCells(grid, cell, 1) : [];
  return buildClickContext(clickPoint, cell, neighbors);
}

function normalizeScreenshotDataUrl(dataUrl: string): string {
  const trimmed = dataUrl.trim();
  if (!trimmed) {
    return trimmed;
  }
  const match = trimmed.match(/^data:image\/(?:png|jpeg|jpg|webp);base64,(.+)$/i);
  return match ? match[1] : trimmed;
}
