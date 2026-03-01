#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const THIS_FILE = fileURLToPath(import.meta.url);
const TOOL_DIR = path.dirname(THIS_FILE);
const READ_TOOL = path.join(TOOL_DIR, "read_ply_for_llm.mjs");
const APPLY_TOOL = path.join(TOOL_DIR, "apply_ply_brush_plan.mjs");
const DEFAULT_SCHEMA_PATH = path.join(TOOL_DIR, "brush-plan.schema.json");
const DEFAULT_EXAMPLE_PLAN = path.join(TOOL_DIR, "examples", "brush-plan.example.json");

function usage() {
  return [
    "Usage:",
    "  node spz-tools/llm_paint_tool.mjs inspect <input.ply> [--sample N] [--context-out file] [--jsonl file] [--prompt-out file] [--max-prompt-samples N] [--schema file]",
    "  node spz-tools/llm_paint_tool.mjs validate-plan --plan plan.json [--schema file]",
    "  node spz-tools/llm_paint_tool.mjs apply <input.ply> --plan plan.json [--out output.ply] [--report report.json] [--dry-run] [--skip-validate] [--schema file]",
    "",
    "Examples:",
    "  node spz-tools/llm_paint_tool.mjs inspect /tmp/scene.ply --sample 300 --prompt-out /tmp/scene.prompt.txt --context-out /tmp/scene.context.json",
    "  node spz-tools/llm_paint_tool.mjs validate-plan --plan ./spz-tools/examples/brush-plan.example.json",
    "  node spz-tools/llm_paint_tool.mjs apply /tmp/scene.ply --plan ./spz-tools/examples/brush-plan.example.json --out /tmp/scene.brushed.ply --report /tmp/scene.brush.report.json"
  ].join("\n");
}

function fail(message) {
  console.error(`[llm-paint-tool] ${message}`);
  process.exit(1);
}

function runNodeScript(scriptPath, args) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: "utf8",
    maxBuffer: 100 * 1024 * 1024,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").trim();
    const stdout = (result.stdout ?? "").trim();
    throw new Error(`Command failed (${path.basename(scriptPath)} ${args.join(" ")}): ${stderr || stdout || "unknown error"}`);
  }
  return result;
}

function asNumber(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${label} must be numeric.`);
  }
  return parsed;
}

function asVec3(value, label) {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new Error(`${label} must be a 3-number array.`);
  }
  const out = value.map((item, index) => asNumber(item, `${label}[${index}]`));
  return out;
}

function parseArgs(argv) {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    console.log(usage());
    process.exit(0);
  }

  const command = argv[0];
  const rest = argv.slice(1);

  if (command === "inspect") {
    if (rest.length === 0) fail("inspect requires <input.ply>");
    const options = {
      inputPath: rest[0],
      sample: 300,
      contextOut: null,
      jsonlOut: null,
      promptOut: null,
      maxPromptSamples: 80,
      schemaPath: DEFAULT_SCHEMA_PATH,
    };

    for (let i = 1; i < rest.length; i += 1) {
      const token = rest[i];
      if (token === "--sample") {
        options.sample = Number.parseInt(rest[++i], 10);
        continue;
      }
      if (token === "--context-out") {
        options.contextOut = rest[++i];
        continue;
      }
      if (token === "--jsonl") {
        options.jsonlOut = rest[++i];
        continue;
      }
      if (token === "--prompt-out") {
        options.promptOut = rest[++i];
        continue;
      }
      if (token === "--max-prompt-samples") {
        options.maxPromptSamples = Number.parseInt(rest[++i], 10);
        continue;
      }
      if (token === "--schema") {
        options.schemaPath = rest[++i];
        continue;
      }
      fail(`Unknown inspect option: ${token}`);
    }
    if (!Number.isFinite(options.sample) || options.sample < 0) {
      fail("--sample must be a non-negative integer.");
    }
    if (!Number.isFinite(options.maxPromptSamples) || options.maxPromptSamples < 0) {
      fail("--max-prompt-samples must be a non-negative integer.");
    }
    return { command, options };
  }

  if (command === "validate-plan") {
    const options = {
      planPath: null,
      schemaPath: DEFAULT_SCHEMA_PATH,
    };
    for (let i = 0; i < rest.length; i += 1) {
      const token = rest[i];
      if (token === "--plan") {
        options.planPath = rest[++i];
        continue;
      }
      if (token === "--schema") {
        options.schemaPath = rest[++i];
        continue;
      }
      fail(`Unknown validate-plan option: ${token}`);
    }
    if (!options.planPath) fail("validate-plan requires --plan <plan.json>");
    return { command, options };
  }

  if (command === "apply") {
    if (rest.length === 0) fail("apply requires <input.ply>");
    const options = {
      inputPath: rest[0],
      planPath: null,
      outPath: null,
      reportPath: null,
      dryRun: false,
      skipValidate: false,
      schemaPath: DEFAULT_SCHEMA_PATH,
    };
    for (let i = 1; i < rest.length; i += 1) {
      const token = rest[i];
      if (token === "--plan") {
        options.planPath = rest[++i];
        continue;
      }
      if (token === "--out") {
        options.outPath = rest[++i];
        continue;
      }
      if (token === "--report") {
        options.reportPath = rest[++i];
        continue;
      }
      if (token === "--dry-run") {
        options.dryRun = true;
        continue;
      }
      if (token === "--skip-validate") {
        options.skipValidate = true;
        continue;
      }
      if (token === "--schema") {
        options.schemaPath = rest[++i];
        continue;
      }
      fail(`Unknown apply option: ${token}`);
    }
    if (!options.planPath) fail("apply requires --plan <plan.json>");
    if (!options.dryRun && !options.outPath) fail("apply requires --out <output.ply> unless --dry-run is set.");
    return { command, options };
  }

  fail(`Unknown command: ${command}`);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function requireFile(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} not found: ${filePath}`);
  }
}

function listUnknownKeys(obj, allowedKeys) {
  const allowedSet = new Set(allowedKeys);
  return Object.keys(obj).filter((key) => !allowedSet.has(key));
}

function validatePlanObject(plan) {
  const errors = [];
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
    errors.push("Plan must be a JSON object.");
    return errors;
  }

  const topUnknown = listUnknownKeys(plan, ["operations"]);
  if (topUnknown.length > 0) {
    errors.push(`Top-level unknown fields: ${topUnknown.join(", ")}`);
  }

  if (!Array.isArray(plan.operations) || plan.operations.length === 0) {
    errors.push("operations must be a non-empty array.");
    return errors;
  }

  const validModes = new Set(["paint", "erase", "lighten", "darken", "set_opacity", "add_opacity"]);
  const validShapes = new Set(["capsule", "sphere", "box"]);
  const validFalloff = new Set(["hard", "linear", "smoothstep"]);
  const allowedFields = [
    "id", "mode", "shape", "strength", "falloff", "origin", "direction", "depth", "radius",
    "center", "halfSize", "colorDc", "amount", "eraseOpacity", "opacity", "opacityDelta",
    "opacityMin", "opacityMax"
  ];

  for (let i = 0; i < plan.operations.length; i += 1) {
    const op = plan.operations[i];
    const prefix = `operations[${i}]`;
    if (typeof op !== "object" || op === null || Array.isArray(op)) {
      errors.push(`${prefix} must be an object.`);
      continue;
    }

    const unknown = listUnknownKeys(op, allowedFields);
    if (unknown.length > 0) {
      errors.push(`${prefix} unknown fields: ${unknown.join(", ")}`);
    }

    if (!validModes.has(op.mode)) {
      errors.push(`${prefix}.mode must be one of: ${[...validModes].join(", ")}`);
    }
    if (!validShapes.has(op.shape)) {
      errors.push(`${prefix}.shape must be one of: ${[...validShapes].join(", ")}`);
    }
    if (op.falloff !== undefined && !validFalloff.has(op.falloff)) {
      errors.push(`${prefix}.falloff must be one of: ${[...validFalloff].join(", ")}`);
    }
    if (op.strength !== undefined && asNumber(op.strength, `${prefix}.strength`) < 0) {
      errors.push(`${prefix}.strength must be >= 0`);
    }

    try {
      if (op.shape === "capsule") {
        asVec3(op.origin, `${prefix}.origin`);
        asVec3(op.direction, `${prefix}.direction`);
        if (asNumber(op.depth, `${prefix}.depth`) <= 0) errors.push(`${prefix}.depth must be > 0`);
        if (asNumber(op.radius, `${prefix}.radius`) <= 0) errors.push(`${prefix}.radius must be > 0`);
      } else if (op.shape === "sphere") {
        asVec3(op.center, `${prefix}.center`);
        if (asNumber(op.radius, `${prefix}.radius`) <= 0) errors.push(`${prefix}.radius must be > 0`);
      } else if (op.shape === "box") {
        const half = asVec3(op.halfSize, `${prefix}.halfSize`);
        if (half.some((value) => value <= 0)) errors.push(`${prefix}.halfSize values must be > 0`);
        asVec3(op.center, `${prefix}.center`);
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }

    if (op.mode === "paint" && op.colorDc === undefined) {
      errors.push(`${prefix}.colorDc is required for paint mode.`);
    }
    if (op.mode === "paint" && op.colorDc !== undefined) {
      try {
        asVec3(op.colorDc, `${prefix}.colorDc`);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if ((op.mode === "lighten" || op.mode === "darken") && op.amount === undefined) {
      errors.push(`${prefix}.amount is required for ${op.mode} mode.`);
    }
    if (op.mode === "set_opacity" && op.opacity === undefined) {
      errors.push(`${prefix}.opacity is required for set_opacity mode.`);
    }
    if (op.mode === "add_opacity" && op.opacityDelta === undefined) {
      errors.push(`${prefix}.opacityDelta is required for add_opacity mode.`);
    }
  }

  return errors;
}

function buildPaintPrompt(context, schemaText, maxPromptSamples) {
  const sampled = context?.vertex?.sample?.vertices ?? [];
  const promptSample = sampled.slice(0, Math.max(0, maxPromptSamples));
  const compactContext = {
    sourceFile: context.sourceFile,
    fileSizeBytes: context.fileSizeBytes,
    header: {
      format: context?.header?.format,
      version: context?.header?.version,
      elements: context?.header?.elements,
    },
    vertex: {
      count: context?.vertex?.count,
      propertyCount: context?.vertex?.propertyCount,
      inferredSchema: context?.vertex?.inferredSchema,
      bounds: context?.vertex?.bounds,
      centroid: context?.vertex?.centroid,
      scalarStats: context?.vertex?.scalarStats,
      sample: {
        strategy: context?.vertex?.sample?.strategy,
        requestedCount: context?.vertex?.sample?.requestedCount,
        actualCount: context?.vertex?.sample?.actualCount,
        vertices: promptSample,
      },
    },
  };

  return [
    "You are generating a Gaussian-splat brush plan JSON for a deterministic offline editor.",
    "Return ONLY valid JSON (no markdown fences).",
    "The JSON must validate against this schema:",
    "```json",
    schemaText,
    "```",
    "",
    "Guidance:",
    "- Prefer multiple small operations over one huge operation.",
    "- Use capsule brush for camera-like painting strokes.",
    "- Use sphere/box for local cleanup.",
    "- Keep strength in [0.1, 1.0] unless explicitly requested stronger/weaker.",
    "- For this dataset, color channels are usually f_dc_* values (not plain sRGB).",
    "",
    "Scene context JSON:",
    "```json",
    JSON.stringify(compactContext, null, 2),
    "```",
    "",
    "Output strictly the plan JSON object with top-level `operations`."
  ].join("\n");
}

function commandInspect(options) {
  const inputPath = path.resolve(options.inputPath);
  const schemaPath = path.resolve(options.schemaPath);
  requireFile(inputPath, "Input PLY");
  requireFile(schemaPath, "Schema");

  const args = [inputPath, "--sample", String(options.sample)];
  if (options.jsonlOut) {
    args.push("--jsonl", path.resolve(options.jsonlOut));
  }
  const readResult = runNodeScript(READ_TOOL, args);
  const context = JSON.parse(readResult.stdout);
  const schemaText = fs.readFileSync(schemaPath, "utf8");
  const prompt = buildPaintPrompt(context, schemaText, options.maxPromptSamples);

  if (options.contextOut) {
    const outPath = path.resolve(options.contextOut);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(context, null, 2));
  }
  if (options.promptOut) {
    const outPath = path.resolve(options.promptOut);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `${prompt}\n`);
  }

  const result = {
    generatedAt: new Date().toISOString(),
    input: inputPath,
    schemaPath,
    contextOut: options.contextOut ? path.resolve(options.contextOut) : null,
    promptOut: options.promptOut ? path.resolve(options.promptOut) : null,
    jsonlOut: options.jsonlOut ? path.resolve(options.jsonlOut) : null,
    examplePlanPath: DEFAULT_EXAMPLE_PLAN,
    summary: {
      vertexCount: context?.vertex?.count ?? null,
      bounds: context?.vertex?.bounds ?? null,
      inferredSchema: context?.vertex?.inferredSchema ?? null,
      sampledVerticesInPrompt: Math.min(options.maxPromptSamples, context?.vertex?.sample?.actualCount ?? 0),
    },
    prompt,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function commandValidate(options) {
  const planPath = path.resolve(options.planPath);
  const schemaPath = path.resolve(options.schemaPath);
  requireFile(planPath, "Plan");
  requireFile(schemaPath, "Schema");

  const plan = readJson(planPath);
  const errors = validatePlanObject(plan);
  const result = {
    generatedAt: new Date().toISOString(),
    planPath,
    schemaPath,
    valid: errors.length === 0,
    errors,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (errors.length > 0) {
    process.exit(1);
  }
}

function commandApply(options) {
  const inputPath = path.resolve(options.inputPath);
  const planPath = path.resolve(options.planPath);
  const schemaPath = path.resolve(options.schemaPath);
  requireFile(inputPath, "Input PLY");
  requireFile(planPath, "Plan");
  requireFile(schemaPath, "Schema");

  if (!options.skipValidate) {
    const plan = readJson(planPath);
    const errors = validatePlanObject(plan);
    if (errors.length > 0) {
      fail(`Plan validation failed:\n- ${errors.join("\n- ")}`);
    }
  }

  const args = [inputPath, "--plan", planPath];
  if (options.dryRun) {
    args.push("--dry-run");
  } else {
    args.push("--out", path.resolve(options.outPath));
  }
  if (options.reportPath) {
    args.push("--report", path.resolve(options.reportPath));
  }

  const result = runNodeScript(APPLY_TOOL, args);
  if (result.stdout.trim().length > 0) {
    process.stdout.write(result.stdout);
    if (!result.stdout.endsWith("\n")) {
      process.stdout.write("\n");
    }
  } else {
    process.stdout.write(
      `${JSON.stringify({
        generatedAt: new Date().toISOString(),
        input: inputPath,
        plan: planPath,
        output: options.dryRun ? null : path.resolve(options.outPath),
        report: options.reportPath ? path.resolve(options.reportPath) : null,
        dryRun: options.dryRun,
      }, null, 2)}\n`,
    );
  }
  if (result.stderr.trim().length > 0) {
    process.stderr.write(result.stderr);
    if (!result.stderr.endsWith("\n")) {
      process.stderr.write("\n");
    }
  }
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.command === "inspect") {
    commandInspect(parsed.options);
    return;
  }
  if (parsed.command === "validate-plan") {
    commandValidate(parsed.options);
    return;
  }
  if (parsed.command === "apply") {
    commandApply(parsed.options);
    return;
  }
  fail(`Unknown command: ${parsed.command}`);
}

try {
  main();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
