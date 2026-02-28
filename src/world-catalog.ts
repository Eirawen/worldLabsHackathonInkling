import type { WorldCatalog, WorldEdgeConfig, WorldNodeConfig } from "./types";

const DEFAULT_CATALOG_URL = "/scenes/worlds.json";

const FALLBACK_CATALOG: WorldCatalog = {
  nodes: [
    {
      id: "library",
      label: "Elegant Library",
      sceneUrl: "/scenes/elegant_library_with_fireplace_500k.spz",
      position: [0.3, 0.52],
      description: "Cozy indoor scene with fireplace and furniture",
    },
    {
      id: "throne",
      label: "Throne",
      sceneUrl: "/scenes/throne.spz",
      position: [0.72, 0.52],
      description: "Single dramatic throne room composition",
    },
  ],
  edges: [{ from: "library", to: "throne" }],
  defaultWorldId: "library",
};

export async function loadWorldCatalog(url: string = DEFAULT_CATALOG_URL): Promise<WorldCatalog> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      console.warn(
        `[world-catalog] Failed to load ${url} (status=${response.status}), using fallback catalog`
      );
      return FALLBACK_CATALOG;
    }
    const payload = (await response.json()) as unknown;
    const catalog = validateWorldCatalog(payload);
    if (catalog.nodes.length === 0) {
      console.warn("[world-catalog] Catalog has no valid nodes, using fallback catalog");
      return FALLBACK_CATALOG;
    }
    return catalog;
  } catch (error) {
    console.warn("[world-catalog] Unable to fetch world catalog, using fallback catalog", error);
    return FALLBACK_CATALOG;
  }
}

export function validateWorldCatalog(raw: unknown): WorldCatalog {
  if (!raw || typeof raw !== "object") {
    return FALLBACK_CATALOG;
  }

  const record = raw as {
    nodes?: unknown;
    edges?: unknown;
    defaultWorldId?: unknown;
  };

  const nodes = normalizeNodes(record.nodes);
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = normalizeEdges(record.edges, nodeIds);
  const defaultWorldId =
    typeof record.defaultWorldId === "string" && nodeIds.has(record.defaultWorldId)
      ? record.defaultWorldId
      : nodes[0]?.id;

  return {
    nodes,
    edges,
    defaultWorldId,
  };
}

function normalizeNodes(raw: unknown): WorldNodeConfig[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const seen = new Set<string>();
  const nodes: WorldNodeConfig[] = [];

  for (const item of raw) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const record = item as {
      id?: unknown;
      label?: unknown;
      sceneUrl?: unknown;
      position?: unknown;
      description?: unknown;
    };

    const id = typeof record.id === "string" ? record.id.trim() : "";
    const label = typeof record.label === "string" ? record.label.trim() : "";
    const sceneUrl = typeof record.sceneUrl === "string" ? record.sceneUrl.trim() : "";
    const position = normalizePosition(record.position);
    const description =
      typeof record.description === "string" && record.description.trim()
        ? record.description.trim()
        : undefined;

    if (!id || !label || !sceneUrl || !position) {
      continue;
    }
    if (!sceneUrl.startsWith("/scenes/")) {
      console.warn(`[world-catalog] Ignoring node ${id}: sceneUrl must start with /scenes/`);
      continue;
    }
    if (seen.has(id)) {
      console.warn(`[world-catalog] Ignoring duplicate world id=${id}`);
      continue;
    }

    seen.add(id);
    nodes.push({
      id,
      label,
      sceneUrl,
      position,
      description,
    });
  }

  return nodes;
}

function normalizeEdges(raw: unknown, nodeIds: Set<string>): WorldEdgeConfig[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const edges: WorldEdgeConfig[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as { from?: unknown; to?: unknown };
    const from = typeof record.from === "string" ? record.from.trim() : "";
    const to = typeof record.to === "string" ? record.to.trim() : "";
    if (!from || !to || !nodeIds.has(from) || !nodeIds.has(to) || from === to) {
      continue;
    }
    edges.push({ from, to });
  }

  return edges;
}

function normalizePosition(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length < 2) {
    return null;
  }
  const x = toUnit(value[0]);
  const y = toUnit(value[1]);
  if (x === null || y === null) {
    return null;
  }
  return [x, y];
}

function toUnit(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return Math.min(1, Math.max(0, value));
}
