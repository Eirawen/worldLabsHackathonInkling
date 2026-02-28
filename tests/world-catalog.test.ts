import { describe, expect, it, vi } from "vitest";

describe("world-catalog", () => {
  it("validates a well-formed catalog", async () => {
    const { validateWorldCatalog } = await import("../src/world-catalog");

    const catalog = validateWorldCatalog({
      defaultWorldId: "a",
      nodes: [
        {
          id: "a",
          label: "A",
          sceneUrl: "/scenes/a.spz",
          position: [0.2, 0.6],
        },
        {
          id: "b",
          label: "B",
          sceneUrl: "/scenes/b.spz",
          position: [0.7, 0.4],
        },
      ],
      edges: [{ from: "a", to: "b" }],
    });

    expect(catalog.nodes).toHaveLength(2);
    expect(catalog.edges).toHaveLength(1);
    expect(catalog.defaultWorldId).toBe("a");
  });

  it("drops invalid nodes and edges", async () => {
    const { validateWorldCatalog } = await import("../src/world-catalog");

    const catalog = validateWorldCatalog({
      nodes: [
        {
          id: "ok",
          label: "OK",
          sceneUrl: "/scenes/ok.spz",
          position: [0.2, 0.3],
        },
        {
          id: "badUrl",
          label: "Bad",
          sceneUrl: "/bad/place.spz",
          position: [0.1, 0.2],
        },
        {
          id: "dup",
          label: "dup",
          sceneUrl: "/scenes/d1.spz",
          position: [0.2, 0.2],
        },
        {
          id: "dup",
          label: "dup2",
          sceneUrl: "/scenes/d2.spz",
          position: [0.3, 0.3],
        },
      ],
      edges: [
        { from: "ok", to: "missing" },
        { from: "ok", to: "ok" },
        { from: "ok", to: "dup" },
      ],
    });

    expect(catalog.nodes.map((node) => node.id)).toEqual(["ok", "dup"]);
    expect(catalog.edges).toEqual([{ from: "ok", to: "dup" }]);
    expect(catalog.defaultWorldId).toBe("ok");
  });

  it("falls back when fetch fails", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("network down"));

    const { loadWorldCatalog } = await import("../src/world-catalog");
    const catalog = await loadWorldCatalog("/scenes/worlds.json");

    expect(catalog.nodes.length).toBeGreaterThan(0);
    expect(catalog.defaultWorldId).toBeTruthy();
    fetchMock.mockRestore();
  });
});
