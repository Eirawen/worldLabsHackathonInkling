# LLM Brush Plan Schema

Use this JSON shape when asking an LLM to generate brush edits for `apply_ply_brush_plan.mjs`.

```json
{
  "operations": [
    {
      "id": "optional_name",
      "mode": "paint | erase | lighten | darken | set_opacity | add_opacity",
      "shape": "capsule | sphere | box",

      "strength": 0.0,
      "falloff": "hard | linear | smoothstep",

      "origin": [0, 0, 0],
      "direction": [0, 0, 1],
      "depth": 1.0,
      "radius": 0.2,

      "center": [0, 0, 0],
      "halfSize": [0.2, 0.2, 0.2],

      "colorDc": [0.8, 0.1, 0.7],
      "amount": 0.2,
      "eraseOpacity": -20,
      "opacity": -4,
      "opacityDelta": -1,
      "opacityMin": -6,
      "opacityMax": 6
    }
  ]
}
```

## Field rules

- `shape="capsule"` requires: `origin`, `direction`, `depth`, `radius`
- `shape="sphere"` requires: `center`, `radius`
- `shape="box"` requires: `center`, `halfSize`
- `mode="paint"` uses `colorDc`
- `mode="erase"` uses `eraseOpacity` (default `-20`)
- `mode="lighten"` / `mode="darken"` use `amount`
- `mode="set_opacity"` uses `opacity`
- `mode="add_opacity"` uses `opacityDelta`
- Optional filters: `opacityMin`, `opacityMax`

## Practical guidance for LLM output

- Keep `strength` in `[0.1, 1.0]`
- Start with `falloff="linear"` unless hard edges are required
- Prefer smaller radius/depth first; stack multiple operations for complex edits
- For SPZ-derived gaussian PLY, color fields are usually `f_dc_0/1/2` (not plain sRGB)
