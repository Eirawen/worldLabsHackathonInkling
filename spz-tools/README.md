# SPZ to PLY Utility

This folder provides a local wrapper around [nianticlabs/spz](https://github.com/nianticlabs/spz) so you can convert `.spz` scenes to `.ply` for direct inspection.

## What it does

- Builds the upstream `spz_to_ply` CLI from the bundled `niantic-spz-src/` snapshot.
- Converts your input `.spz` to `.ply`.

If you want to build from a different checkout, set `SPZ_SOURCE_DIR=/path/to/spz`.

## Requirements

- `git` (optional, only if bundled source is missing and fallback clone is needed)
- `cmake`
- C++ toolchain (Xcode CLT on macOS works)

## Usage

From repo root:

```bash
./spz-tools/convert_spz_to_ply.sh <input.spz> [output.ply]
```

Examples:

```bash
./spz-tools/convert_spz_to_ply.sh ./public/scenes/Creative_Studio.spz
./spz-tools/convert_spz_to_ply.sh ./public/scenes/Creative_Studio.spz ./tmp/Creative_Studio.ply
```

If `output.ply` is omitted, output is written next to the input file with the `.ply` extension.

## PLY Reader for LLM Workflows

`read_ply_for_llm.mjs` creates a compact JSON report with:
- Header metadata (`format`, elements, properties, comments)
- Inferred semantic schema (`position`, `color`, `opacity`, `scale`, `rotation`)
- Vertex stats (bounds, centroid, scalar min/max/mean)
- Sampled vertex rows with both `canonical` fields and full `properties`

Usage:

```bash
node ./spz-tools/read_ply_for_llm.mjs <input.ply> [--out report.json] [--sample N] [--all-vertices] [--jsonl samples.jsonl]
```

Examples:

```bash
node ./spz-tools/read_ply_for_llm.mjs /tmp/Creative_Studio.ply --sample 300 --out /tmp/Creative_Studio.llm.json
node ./spz-tools/read_ply_for_llm.mjs /tmp/Creative_Studio.ply --sample 300 --jsonl /tmp/Creative_Studio.samples.jsonl
```

## Brush Editing Tool (LLM Plan -> PLY)

`apply_ply_brush_plan.mjs` applies deterministic brush edits to a gaussian-splat PLY based on a JSON plan.

Supported brush shapes:
- `capsule` (origin + direction + depth + radius) (closest to your Spark painter brush)
- `sphere`
- `box`

Supported modes:
- `paint`
- `erase`
- `lighten`
- `darken`
- `set_opacity`
- `add_opacity`

Run:

```bash
node ./spz-tools/apply_ply_brush_plan.mjs <input.ply> --plan ./spz-tools/examples/brush-plan.example.json --out /tmp/scene.brushed.ply --report /tmp/scene.brush.report.json
```

Dry-run (no file write):

```bash
node ./spz-tools/apply_ply_brush_plan.mjs <input.ply> --plan ./plan.json --dry-run --report /tmp/scene.brush.report.json
```

An example plan is provided at:

```bash
./spz-tools/examples/brush-plan.example.json
```

LLM plan schema reference:

```bash
./spz-tools/LLM_BRUSH_PLAN_SCHEMA.md
```

JSON schema (machine-readable):

```bash
./spz-tools/brush-plan.schema.json
```

## Unified LLM Paint Tool

`llm_paint_tool.mjs` wraps the full workflow into stable commands for agent/tool use.

### 1) Inspect scene and generate prompt/context

```bash
node ./spz-tools/llm_paint_tool.mjs inspect /tmp/Creative_Studio.ply \
  --sample 300 \
  --context-out /tmp/Creative_Studio.context.json \
  --prompt-out /tmp/Creative_Studio.prompt.txt \
  --jsonl /tmp/Creative_Studio.samples.jsonl
```

This produces:
- scene context JSON for grounding
- a ready-to-send LLM prompt that includes the strict plan schema
- optional sampled JSONL rows

### 2) Validate an LLM-produced plan

```bash
node ./spz-tools/llm_paint_tool.mjs validate-plan --plan ./my-plan.json
```

### 3) Apply plan to PLY

```bash
node ./spz-tools/llm_paint_tool.mjs apply /tmp/Creative_Studio.ply \
  --plan ./my-plan.json \
  --out /tmp/Creative_Studio.brushed.ply \
  --report /tmp/Creative_Studio.brush.report.json
```

Dry-run:

```bash
node ./spz-tools/llm_paint_tool.mjs apply /tmp/Creative_Studio.ply \
  --plan ./my-plan.json \
  --dry-run \
  --report /tmp/Creative_Studio.brush.dryrun.report.json
```
