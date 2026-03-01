import type { SplatMesh } from "@sparkjsdev/spark";
import type * as THREE from "three";
import { buildClickContext, type processCommand as processCommandFn } from "./agent";
import type {
  executeOperations as executeOperationsFn,
  undoLastEdit as undoLastEditFn,
} from "./executor";
import { getManifestJSON } from "./scene-manifest";
import { getCellAtWorldPos, getNeighborCells } from "./spatial-index";
import type { SceneManifest, SpatialGrid } from "./types";

type ProcessCommand = typeof processCommandFn;
type ExecuteOperations = typeof executeOperationsFn;
type UndoLastEdit = typeof undoLastEditFn;

interface LoggedOperation {
  action: string;
  blendMode: string;
  shapeCount: number;
  shapeTypes: string[];
}

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
let commandCounter = 0;

export function initUI(deps: UIDependencies): void {
  if (initialized) {
    logUi("initUI skipped (already initialized)");
    return;
  }
  initialized = true;
  logUi("Initializing classic chat UI with verbose logging");

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
    logUi(`setBusy(${busy})`);
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
      logUi("Ignoring empty command");
      return;
    }

    commandCounter += 1;
    const commandId = commandCounter;
    const startedAt = nowMs();
    logUi(`#${commandId} start`, { chars: command.length, command });
    appendMessage(messages, "user", command);
    setBusy(true);
    setStatus(status, `Thinking... (#${commandId})`);

    try {
      const clickPoint = deps.getLastClickPoint();
      const grid = deps.getGrid();
      const manifest = deps.getManifest();
      const splatMesh = deps.getSplatMesh();
      const screenshotRaw = deps.getScreenshot();
      const screenshot = normalizeScreenshotDataUrl(screenshotRaw);
      const apiKey = readGeminiApiKey();

      logUi(`#${commandId} context snapshot`, {
        click: formatVec3OrNull(clickPoint),
        gridReady: Boolean(grid),
        manifestReady: Boolean(manifest),
        screenshotRawChars: screenshotRaw.length,
        screenshotBytes: screenshot.length,
        screenshotPrefix: screenshot.slice(0, 20),
        apiKeyPresent: apiKey.length > 0,
      });

      const voxelContext = buildVoxelContext(grid, clickPoint);
      const manifestSummary = manifest ? getManifestJSON(manifest) : null;
      logUi(`#${commandId} prompt payload sizes`, {
        voxelContextChars: voxelContext?.length ?? 0,
        manifestChars: manifestSummary?.length ?? 0,
      });
      if (voxelContext) {
        logUi(`#${commandId} voxelContext preview`, voxelContext.slice(0, 280));
      }
      if (manifestSummary) {
        logUi(`#${commandId} manifest preview`, manifestSummary.slice(0, 280));
      }

      const operations = await deps.processCommand(
        command,
        clickPoint,
        voxelContext,
        manifestSummary,
        screenshot,
        apiKey
      );

      logUi(`#${commandId} agent output`, {
        opCount: operations.length,
        summary: summarizeOperations(operations),
        compact: toLoggedOperations(operations),
      });
      try {
        logUi(`#${commandId} agent output raw`, JSON.stringify(operations));
      } catch {
        logUi(`#${commandId} agent output raw`, "<unserializable>");
      }

      const historyBefore = getHistoryCountGuess();
      deps.executeOperations(operations, splatMesh);
      const historyAfter = getHistoryCountGuess();
      logUi(`#${commandId} execute complete`, {
        historyBefore,
        historyAfter,
      });

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

      setStatus(status, "Ready");
      input.value = "";
      const elapsedMs = nowMs() - startedAt;
      logUi(`#${commandId} complete`, { elapsedMs: Number(elapsedMs.toFixed(1)) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logUi(`#${commandId} failed`, message);
      console.error("[ui] Command failed", error);
      appendMessage(messages, "error", `Error: ${message}`);
      showToast("Command failed", 2500);
      setStatus(status, "Ready");
    } finally {
      setBusy(false);
    }
  };

  sendButton.addEventListener("click", () => {
    logUi("Send button clicked");
    void handleSend();
  });

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      logUi("Input Enter pressed");
      event.preventDefault();
      void handleSend();
    }
  });

  undoButton.addEventListener("click", () => {
    logUi("Undo button clicked");
    const undone = deps.undoLastEdit();
    logUi("Undo result", { undone });
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
    logUi("Undo shortcut triggered");
    event.preventDefault();
    const undone = deps.undoLastEdit();
    logUi("Undo shortcut result", { undone });
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
  logUi(`Toast: "${message}" (${duration}ms)`);

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
  logUi("appendMessage", { kind, chars: text.length });

  const maxMessages = 14;
  while (container.children.length > maxMessages) {
    container.firstElementChild?.remove();
  }
}

function setStatus(statusEl: HTMLDivElement, text: string): void {
  statusEl.textContent = text;
  logUi(`status="${text}"`);
}

function buildVoxelContext(
  grid: SpatialGrid | null,
  clickPoint: THREE.Vector3 | null
): string | null {
  if (!grid || !clickPoint) {
    logUi("buildVoxelContext skipped", {
      hasGrid: Boolean(grid),
      hasClickPoint: Boolean(clickPoint),
    });
    return null;
  }

  const cell = getCellAtWorldPos(grid, clickPoint);
  const neighbors = cell ? getNeighborCells(grid, cell, 1) : [];
  logUi("buildVoxelContext inputs", {
    cell: cell ? cell.gridPos.join(",") : "none",
    neighbors: neighbors.length,
  });
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

function toLoggedOperations(
  operations: Array<{ action: string; blendMode: string; shapes: Array<{ type: string }> }>
): LoggedOperation[] {
  return operations.map((op) => ({
    action: op.action,
    blendMode: op.blendMode,
    shapeCount: op.shapes.length,
    shapeTypes: op.shapes.map((shape) => shape.type),
  }));
}

function readGeminiApiKey(): string {
  const key = String(
    import.meta.env.VITE_GEMINI_API_KEY ?? import.meta.env.GEMINI_API_KEY ?? ""
  ).trim();
  if (!key) {
    logUi("Gemini API key missing");
  }
  return key;
}

function getHistoryCountGuess(): number {
  const historyProbe = (window as unknown as { __MUSE_HISTORY_COUNT__?: number }).__MUSE_HISTORY_COUNT__;
  return typeof historyProbe === "number" ? historyProbe : -1;
}

function logUi(message: string, payload?: unknown): void {
  const stamp = new Date().toISOString();
  if (payload === undefined) {
    console.log(`[ui][${stamp}] ${message}`);
    return;
  }
  console.log(`[ui][${stamp}] ${message}`, payload);
}

function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}
