import * as THREE from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildClickContext, processCommand, SYSTEM_PROMPT } from "../src/agent";
import type { VoxelCell } from "../src/types";

type FetchMock = ReturnType<typeof vi.fn>;

const API_KEY = "test-api-key";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SYSTEM_PROMPT", () => {
  it("contains required command-to-JSON examples and output constraints", () => {
    expect(SYSTEM_PROMPT).toContain("Example A");
    expect(SYSTEM_PROMPT).toContain("Example J");
    expect(SYSTEM_PROMPT).toContain("Return ONLY a JSON array");
    expect(SYSTEM_PROMPT).toContain("extractAsset: true");
  });
});

describe("buildClickContext", () => {
  it("formats click context with primary cell and nearest neighbors", () => {
    const click = new THREE.Vector3(1, 2, 3);
    const primary = makeCell([1, 2, 3], [0, 0, 0], [2, 4, 6], 100, [0.2, 0.4, 0.6], 0.03);
    const neighborNear = makeCell([1, 2, 4], [1, 1, 1], [3, 3, 5], 40, [0.1, 0.2, 0.3], 0.02);
    const neighborFar = makeCell([8, 9, 9], [10, 10, 10], [12, 12, 12], 10, [0.8, 0.3, 0.1], 0.1);

    const text = buildClickContext(click, primary, [primary, neighborFar, neighborNear]);

    expect(text).toContain("Click position:");
    expect(text).toContain("Primary cell: key=1,2,3");
    expect(text).toContain("Neighbor cells (nearest first):");
    const nearIndex = text.indexOf("key=1,2,4");
    const farIndex = text.indexOf("key=8,9,9");
    expect(nearIndex).toBeGreaterThan(-1);
    expect(farIndex).toBeGreaterThan(-1);
    expect(nearIndex).toBeLessThan(farIndex);
  });

  it("handles missing primary cell safely", () => {
    const click = new THREE.Vector3(5, 1, -2);
    const text = buildClickContext(click, null, []);
    expect(text).toContain("Primary cell: none");
    expect(text).toContain("Nearby occupied cells: none.");
  });
});

describe("processCommand", () => {
  it("parses raw JSON response and enforces delete defaults", async () => {
    const fetchMock = mockFetchWithResponses([
      anthropicOkResponse(
        '[{"action":"delete","blendMode":"ADD_RGBA","shapes":[{"type":"SPHERE","position":[1,2,3],"opacity":1}]}]'
      ),
    ]);

    const ops = await processCommand(
      "remove this",
      new THREE.Vector3(1, 2, 3),
      "cell-data",
      "scene-summary",
      null,
      API_KEY
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(ops).toHaveLength(1);
    expect(ops[0]?.action).toBe("delete");
    expect(ops[0]?.blendMode).toBe("MULTIPLY");
    expect(ops[0]?.extractAsset).toBe(true);
    expect(ops[0]?.assetLabel).toBeTruthy();
    expect(ops[0]?.softEdge).toBeCloseTo(0.1);
    expect(ops[0]?.shapes[0]?.opacity).toBe(0);
  });

  it("parses markdown-wrapped JSON", async () => {
    mockFetchWithResponses([
      anthropicOkResponse('```json\n[{"action":"light","blendMode":"ADD_RGBA","shapes":[{"type":"SPHERE","position":[0,3,0],"radius":4.5,"color":[0.2,0.1,0.05]}]}]\n```'),
    ]);

    const ops = await processCommand(
      "make it warmer",
      null,
      null,
      null,
      null,
      API_KEY
    );

    expect(ops).toHaveLength(1);
    expect(ops[0]?.action).toBe("light");
    expect(ops[0]?.blendMode).toBe("ADD_RGBA");
    expect(ops[0]?.softEdge).toBeCloseTo(0.2);
  });

  it("retries once when first parse fails and succeeds on second response", async () => {
    const fetchMock = mockFetchWithResponses([
      anthropicOkResponse('{ "not": "array" }'),
      anthropicOkResponse(
        '[{"action":"recolor","blendMode":"SET_RGB","shapes":[{"type":"BOX","position":[0,0,0],"scale":[1,1,1],"color":[0.9,0.2,0.2]}]}]'
      ),
    ]);

    const ops = await processCommand(
      "make this red",
      new THREE.Vector3(0, 0, 0),
      "voxel context",
      "manifest summary",
      "data:image/png;base64,QUJDRA==",
      API_KEY
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(ops).toHaveLength(1);
    expect(ops[0]?.action).toBe("recolor");

    const firstBody = getFetchBody(fetchMock, 0);
    const secondBody = getFetchBody(fetchMock, 1);
    expect(firstBody.messages[0].content[0].type).toBe("image");
    expect(firstBody.messages[0].content[0].source.data).toBe("QUJDRA==");
    expect(secondBody.messages[0].content[1].text).toContain(
      "Return only valid JSON array of EditOperation objects. No markdown."
    );
  });

  it("throws after retry exhaustion on invalid shape schema", async () => {
    const fetchMock = mockFetchWithResponses([
      anthropicOkResponse(
        '[{"action":"light","blendMode":"ADD_RGBA","shapes":[{"type":"NOT_A_SHAPE","position":[0,0,0]}]}]'
      ),
      anthropicOkResponse(
        '[{"action":"light","blendMode":"ADD_RGBA","shapes":[{"type":"NOT_A_SHAPE","position":[0,0,0]}]}]'
      ),
    ]);

    await expect(
      processCommand("bad output", null, null, null, null, API_KEY)
    ).rejects.toThrow("invalid type");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("sends required Anthropic headers and request body fields", async () => {
    const fetchMock = mockFetchWithResponses([
      anthropicOkResponse(
        '[{"action":"atmosphere","blendMode":"ADD_RGBA","shapes":[{"type":"ALL","position":[0,0,0],"color":[0.05,0.05,0.08]}]}]'
      ),
    ]);

    await processCommand("make it foggy", null, null, null, null, API_KEY);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      "Content-Type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    });

    const body = JSON.parse(String(init.body)) as {
      model: string;
      temperature: number;
      max_tokens: number;
      messages: Array<{ content: Array<{ type: string }> }>;
    };
    expect(body.model).toBe("claude-sonnet-4-20250514");
    expect(body.temperature).toBe(0);
    expect(body.max_tokens).toBe(4096);
    expect(body.messages[0]?.content.at(-1)?.type).toBe("text");
  });
});

function mockFetchWithResponses(responses: Response[]): FetchMock {
  const fetchMock = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>();
  for (const response of responses) {
    fetchMock.mockResolvedValueOnce(response);
  }
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function anthropicOkResponse(text: string): Response {
  return new Response(
    JSON.stringify({
      content: [{ type: "text", text }],
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }
  );
}

function getFetchBody(fetchMock: FetchMock, callIndex: number): {
  messages: Array<{ content: Array<{ type: string; source?: { data: string }; text?: string }> }>;
} {
  const [, init] = fetchMock.mock.calls[callIndex] as [string, RequestInit];
  return JSON.parse(String(init.body));
}

function makeCell(
  gridPos: [number, number, number],
  min: [number, number, number],
  max: [number, number, number],
  splatCount: number,
  avgColor: [number, number, number],
  colorVariance: number
): VoxelCell {
  const bounds = new THREE.Box3(
    new THREE.Vector3(...min),
    new THREE.Vector3(...max)
  );
  const center = new THREE.Vector3().addVectors(bounds.min, bounds.max).multiplyScalar(0.5);
  return {
    gridPos,
    worldCenter: center,
    worldBounds: bounds,
    splatCount,
    avgColor: new THREE.Color(...avgColor),
    colorVariance,
    density: 1.5,
    splatIndices: [],
  };
}
