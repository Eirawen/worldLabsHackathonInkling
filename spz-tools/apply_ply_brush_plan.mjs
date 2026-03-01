#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const PLY_TYPE_ALIASES = {
  char: "int8",
  int8: "int8",
  uchar: "uint8",
  uint8: "uint8",
  short: "int16",
  int16: "int16",
  ushort: "uint16",
  uint16: "uint16",
  int: "int32",
  int32: "int32",
  uint: "uint32",
  uint32: "uint32",
  float: "float32",
  float32: "float32",
  double: "float64",
  float64: "float64",
};

const PLY_TYPE_SIZE = {
  int8: 1,
  uint8: 1,
  int16: 2,
  uint16: 2,
  int32: 4,
  uint32: 4,
  float32: 4,
  float64: 8,
};

const TYPE_RANGES = {
  int8: [-128, 127],
  uint8: [0, 255],
  int16: [-32768, 32767],
  uint16: [0, 65535],
  int32: [-2147483648, 2147483647],
  uint32: [0, 4294967295],
};

function usage() {
  return [
    "Usage:",
    "  node spz-tools/apply_ply_brush_plan.mjs <input.ply> --plan plan.json [--out output.ply] [--report report.json] [--dry-run]",
    "",
    "Examples:",
    "  node spz-tools/apply_ply_brush_plan.mjs /tmp/scene.ply --plan ./spz-tools/examples/brush-plan.example.json --out /tmp/scene.brushed.ply",
    "  node spz-tools/apply_ply_brush_plan.mjs /tmp/scene.ply --plan ./plan.json --dry-run --report /tmp/scene.brush.report.json",
    "",
    "Notes:",
    "  - This tool targets gaussian splat PLYs (vertex scalar properties, usually binary_little_endian).",
    "  - It supports brush shapes: capsule, sphere, box.",
    "  - Modes: paint, erase, lighten, darken, set_opacity, add_opacity.",
  ].join("\n");
}

function fail(message) {
  console.error(`[ply-brush] ${message}`);
  process.exit(1);
}

function normalizePlyType(typeName) {
  const normalized = PLY_TYPE_ALIASES[typeName.toLowerCase()];
  if (!normalized) {
    throw new Error(`Unsupported PLY type: ${typeName}`);
  }
  return normalized;
}

function parseArgs(argv) {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    console.log(usage());
    process.exit(0);
  }

  const args = {
    inputPath: null,
    planPath: null,
    outputPath: null,
    reportPath: null,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("-") && args.inputPath === null) {
      args.inputPath = token;
      continue;
    }
    if (token === "--plan") {
      const value = argv[i + 1];
      if (!value) fail("--plan requires a JSON path");
      args.planPath = value;
      i += 1;
      continue;
    }
    if (token === "--out") {
      const value = argv[i + 1];
      if (!value) fail("--out requires a file path");
      args.outputPath = value;
      i += 1;
      continue;
    }
    if (token === "--report") {
      const value = argv[i + 1];
      if (!value) fail("--report requires a file path");
      args.reportPath = value;
      i += 1;
      continue;
    }
    if (token === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    fail(`Unknown argument: ${token}`);
  }

  if (!args.inputPath) fail("Input .ply path is required.");
  if (!args.planPath) fail("--plan is required.");
  if (!args.dryRun && !args.outputPath) {
    fail("--out is required unless --dry-run is set.");
  }

  return args;
}

function parseHeader(buffer) {
  const endHeaderLf = buffer.indexOf("end_header\n", 0, "utf8");
  const endHeaderCrLf = buffer.indexOf("end_header\r\n", 0, "utf8");
  let headerEndOffset = -1;
  if (endHeaderCrLf !== -1) {
    headerEndOffset = endHeaderCrLf + "end_header\r\n".length;
  } else if (endHeaderLf !== -1) {
    headerEndOffset = endHeaderLf + "end_header\n".length;
  }
  if (headerEndOffset === -1) {
    throw new Error("Could not find end_header.");
  }

  const text = buffer.slice(0, headerEndOffset).toString("utf8");
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines[0] !== "ply") {
    throw new Error("Invalid PLY magic.");
  }

  const header = {
    format: null,
    version: null,
    elements: [],
    headerEndOffset,
  };

  let currentElement = null;
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i].trim();
    const tokens = line.split(/\s+/);
    if (tokens[0] === "format") {
      header.format = tokens[1] ?? null;
      header.version = tokens[2] ?? null;
      continue;
    }
    if (tokens[0] === "element") {
      if (tokens.length < 3) throw new Error(`Invalid element line: ${line}`);
      currentElement = {
        name: tokens[1],
        count: Number.parseInt(tokens[2], 10),
        properties: [],
      };
      if (!Number.isFinite(currentElement.count) || currentElement.count < 0) {
        throw new Error(`Invalid element count: ${line}`);
      }
      header.elements.push(currentElement);
      continue;
    }
    if (tokens[0] === "property") {
      if (!currentElement) throw new Error(`Property before element: ${line}`);
      if (tokens[1] === "list") {
        if (tokens.length < 5) throw new Error(`Invalid list property: ${line}`);
        currentElement.properties.push({
          kind: "list",
          name: tokens[4],
          countType: normalizePlyType(tokens[2]),
          itemType: normalizePlyType(tokens[3]),
        });
      } else {
        if (tokens.length < 3) throw new Error(`Invalid scalar property: ${line}`);
        currentElement.properties.push({
          kind: "scalar",
          name: tokens[2],
          type: normalizePlyType(tokens[1]),
        });
      }
    }
  }

  if (!header.format) throw new Error("Missing format in header.");
  return header;
}

function readScalar(view, offset, type, littleEndian) {
  switch (type) {
    case "int8":
      return [view.getInt8(offset), offset + 1];
    case "uint8":
      return [view.getUint8(offset), offset + 1];
    case "int16":
      return [view.getInt16(offset, littleEndian), offset + 2];
    case "uint16":
      return [view.getUint16(offset, littleEndian), offset + 2];
    case "int32":
      return [view.getInt32(offset, littleEndian), offset + 4];
    case "uint32":
      return [view.getUint32(offset, littleEndian), offset + 4];
    case "float32":
      return [view.getFloat32(offset, littleEndian), offset + 4];
    case "float64":
      return [view.getFloat64(offset, littleEndian), offset + 8];
    default:
      throw new Error(`Unsupported scalar type: ${type}`);
  }
}

function writeScalar(view, offset, type, value, littleEndian) {
  switch (type) {
    case "int8":
      view.setInt8(offset, value);
      return;
    case "uint8":
      view.setUint8(offset, value);
      return;
    case "int16":
      view.setInt16(offset, value, littleEndian);
      return;
    case "uint16":
      view.setUint16(offset, value, littleEndian);
      return;
    case "int32":
      view.setInt32(offset, value, littleEndian);
      return;
    case "uint32":
      view.setUint32(offset, value, littleEndian);
      return;
    case "float32":
      view.setFloat32(offset, value, littleEndian);
      return;
    case "float64":
      view.setFloat64(offset, value, littleEndian);
      return;
    default:
      throw new Error(`Unsupported scalar type: ${type}`);
  }
}

function clampByType(type, value) {
  if (type === "float32" || type === "float64") {
    if (!Number.isFinite(value)) {
      return 0;
    }
    return value;
  }
  const range = TYPE_RANGES[type];
  if (!range) {
    return value;
  }
  const rounded = Math.round(value);
  return Math.min(range[1], Math.max(range[0], rounded));
}

function normalizeDirection(direction) {
  if (!Array.isArray(direction) || direction.length !== 3) {
    throw new Error("direction must be [x,y,z]");
  }
  const x = Number(direction[0]);
  const y = Number(direction[1]);
  const z = Number(direction[2]);
  const length = Math.hypot(x, y, z);
  if (!Number.isFinite(length) || length === 0) {
    throw new Error("direction must be finite and non-zero");
  }
  return [x / length, y / length, z / length];
}

function asVec3(name, value) {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new Error(`${name} must be [x,y,z]`);
  }
  return [Number(value[0]), Number(value[1]), Number(value[2])];
}

function parsePlan(planObj) {
  const operations = Array.isArray(planObj.operations) ? planObj.operations : null;
  if (!operations || operations.length === 0) {
    throw new Error("plan.operations must be a non-empty array.");
  }

  return operations.map((op, index) => {
    const id = typeof op.id === "string" ? op.id : `op_${index}`;
    const mode = String(op.mode ?? "paint");
    const shape = String(op.shape ?? "capsule");
    const strength = Number(op.strength ?? 1.0);
    const falloff = String(op.falloff ?? "linear");

    if (!Number.isFinite(strength) || strength < 0) {
      throw new Error(`${id}: strength must be >= 0`);
    }
    if (!["hard", "linear", "smoothstep"].includes(falloff)) {
      throw new Error(`${id}: falloff must be one of hard|linear|smoothstep`);
    }
    if (!["paint", "erase", "lighten", "darken", "set_opacity", "add_opacity"].includes(mode)) {
      throw new Error(`${id}: unsupported mode ${mode}`);
    }
    if (!["capsule", "sphere", "box"].includes(shape)) {
      throw new Error(`${id}: unsupported shape ${shape}`);
    }

    const parsed = {
      id,
      mode,
      shape,
      strength,
      falloff,
      colorDc: op.colorDc ? asVec3(`${id}.colorDc`, op.colorDc) : null,
      amount: Number(op.amount ?? 0.2),
      eraseOpacity: Number(op.eraseOpacity ?? -20.0),
      opacity: op.opacity === undefined ? null : Number(op.opacity),
      opacityDelta: Number(op.opacityDelta ?? 0.0),
      opacityMin: op.opacityMin === undefined ? null : Number(op.opacityMin),
      opacityMax: op.opacityMax === undefined ? null : Number(op.opacityMax),
      stats: {
        insideCount: 0,
        changedCount: 0,
      },
    };

    if (shape === "capsule") {
      parsed.origin = asVec3(`${id}.origin`, op.origin);
      parsed.direction = normalizeDirection(op.direction);
      parsed.depth = Number(op.depth ?? 1.0);
      parsed.radius = Number(op.radius ?? 0.2);
      if (!Number.isFinite(parsed.depth) || parsed.depth <= 0) throw new Error(`${id}: depth must be > 0`);
      if (!Number.isFinite(parsed.radius) || parsed.radius <= 0) throw new Error(`${id}: radius must be > 0`);
    } else if (shape === "sphere") {
      parsed.center = asVec3(`${id}.center`, op.center);
      parsed.radius = Number(op.radius ?? 0.2);
      if (!Number.isFinite(parsed.radius) || parsed.radius <= 0) throw new Error(`${id}: radius must be > 0`);
    } else if (shape === "box") {
      parsed.center = asVec3(`${id}.center`, op.center);
      parsed.halfSize = asVec3(`${id}.halfSize`, op.halfSize);
      if (parsed.halfSize.some((v) => !Number.isFinite(v) || v <= 0)) {
        throw new Error(`${id}: halfSize entries must be > 0`);
      }
    }

    return parsed;
  });
}

function computeFalloff(t, mode) {
  if (mode === "hard") return 1.0;
  if (mode === "linear") return 1.0 - t;
  // smoothstep
  const s = 1.0 - t;
  return s * s * (3.0 - 2.0 * s);
}

function influenceForOperation(op, position) {
  if (op.shape === "capsule") {
    const ox = position[0] - op.origin[0];
    const oy = position[1] - op.origin[1];
    const oz = position[2] - op.origin[2];
    const projection = ox * op.direction[0] + oy * op.direction[1] + oz * op.direction[2];
    if (projection < 0 || projection > op.depth) return 0;
    const px = op.origin[0] + op.direction[0] * projection;
    const py = op.origin[1] + op.direction[1] * projection;
    const pz = op.origin[2] + op.direction[2] * projection;
    const dx = position[0] - px;
    const dy = position[1] - py;
    const dz = position[2] - pz;
    const dist = Math.hypot(dx, dy, dz);
    if (dist >= op.radius) return 0;
    return op.strength * computeFalloff(dist / op.radius, op.falloff);
  }

  if (op.shape === "sphere") {
    const dx = position[0] - op.center[0];
    const dy = position[1] - op.center[1];
    const dz = position[2] - op.center[2];
    const dist = Math.hypot(dx, dy, dz);
    if (dist >= op.radius) return 0;
    return op.strength * computeFalloff(dist / op.radius, op.falloff);
  }

  // box
  const ax = Math.abs(position[0] - op.center[0]) / op.halfSize[0];
  const ay = Math.abs(position[1] - op.center[1]) / op.halfSize[1];
  const az = Math.abs(position[2] - op.center[2]) / op.halfSize[2];
  if (ax >= 1 || ay >= 1 || az >= 1) return 0;
  const t = Math.max(ax, ay, az);
  return op.strength * computeFalloff(t, op.falloff);
}

function resolvePropertyTriplet(availableNames, candidates) {
  const lower = new Map();
  for (const name of availableNames) lower.set(name.toLowerCase(), name);
  for (const candidate of candidates) {
    if (candidate.every((entry) => lower.has(entry))) {
      return candidate.map((entry) => lower.get(entry));
    }
  }
  return null;
}

function resolvePropertySingle(availableNames, candidates) {
  const lower = new Map();
  for (const name of availableNames) lower.set(name.toLowerCase(), name);
  for (const candidate of candidates) {
    if (lower.has(candidate)) return lower.get(candidate);
  }
  return null;
}

function applyOperationToVertex(op, state, mapping) {
  const position = [state[mapping.position[0]], state[mapping.position[1]], state[mapping.position[2]]];
  const influence = influenceForOperation(op, position);
  if (influence <= 0) {
    return false;
  }

  const opacityName = mapping.opacity;
  if (opacityName && op.opacityMin !== null && state[opacityName] < op.opacityMin) {
    return false;
  }
  if (opacityName && op.opacityMax !== null && state[opacityName] > op.opacityMax) {
    return false;
  }

  op.stats.insideCount += 1;
  let changed = false;

  if (op.mode === "paint" || op.mode === "lighten" || op.mode === "darken") {
    if (!mapping.color) {
      return false;
    }
  }
  if (["erase", "set_opacity", "add_opacity"].includes(op.mode) && !opacityName) {
    return false;
  }

  if (op.mode === "paint" && mapping.color && op.colorDc) {
    for (let i = 0; i < 3; i += 1) {
      const name = mapping.color[i];
      const oldValue = state[name];
      const targetValue = op.colorDc[i];
      const nextValue = oldValue + (targetValue - oldValue) * Math.min(1, influence);
      if (nextValue !== oldValue) {
        state[name] = nextValue;
        changed = true;
      }
    }
  } else if (op.mode === "lighten" && mapping.color) {
    for (let i = 0; i < 3; i += 1) {
      const name = mapping.color[i];
      const oldValue = state[name];
      const nextValue = oldValue + Math.abs(op.amount) * influence;
      if (nextValue !== oldValue) {
        state[name] = nextValue;
        changed = true;
      }
    }
  } else if (op.mode === "darken" && mapping.color) {
    for (let i = 0; i < 3; i += 1) {
      const name = mapping.color[i];
      const oldValue = state[name];
      const nextValue = oldValue - Math.abs(op.amount) * influence;
      if (nextValue !== oldValue) {
        state[name] = nextValue;
        changed = true;
      }
    }
  } else if (op.mode === "erase" && opacityName) {
    const oldValue = state[opacityName];
    const nextValue = oldValue + (op.eraseOpacity - oldValue) * Math.min(1, influence);
    if (nextValue !== oldValue) {
      state[opacityName] = nextValue;
      changed = true;
    }
  } else if (op.mode === "set_opacity" && opacityName && op.opacity !== null) {
    const oldValue = state[opacityName];
    const nextValue = oldValue + (op.opacity - oldValue) * Math.min(1, influence);
    if (nextValue !== oldValue) {
      state[opacityName] = nextValue;
      changed = true;
    }
  } else if (op.mode === "add_opacity" && opacityName) {
    const oldValue = state[opacityName];
    const nextValue = oldValue + op.opacityDelta * influence;
    if (nextValue !== oldValue) {
      state[opacityName] = nextValue;
      changed = true;
    }
  }

  if (changed) {
    op.stats.changedCount += 1;
  }
  return changed;
}

function processBinaryPly(inputBuffer, header, operations, dryRun) {
  if (header.elements.length !== 1 || header.elements[0].name !== "vertex") {
    throw new Error("This brush tool currently requires a vertex-only PLY.");
  }
  const vertex = header.elements[0];
  if (vertex.properties.some((prop) => prop.kind !== "scalar")) {
    throw new Error("This brush tool currently supports only scalar vertex properties.");
  }

  const properties = vertex.properties;
  const propertyOffsets = new Map();
  let rowSize = 0;
  for (const prop of properties) {
    propertyOffsets.set(prop.name, { offset: rowSize, type: prop.type });
    rowSize += PLY_TYPE_SIZE[prop.type];
  }

  const expectedData = header.headerEndOffset + rowSize * vertex.count;
  if (inputBuffer.length < expectedData) {
    throw new Error(`File too small: expected at least ${expectedData} bytes`);
  }

  const propertyNames = properties.map((prop) => prop.name);
  const positionTriplet = resolvePropertyTriplet(propertyNames, [["x", "y", "z"]]);
  if (!positionTriplet) {
    throw new Error("Vertex properties must include x,y,z.");
  }
  const colorTriplet = resolvePropertyTriplet(propertyNames, [
    ["f_dc_0", "f_dc_1", "f_dc_2"],
    ["red", "green", "blue"],
    ["r", "g", "b"],
  ]);
  const opacityName = resolvePropertySingle(propertyNames, ["opacity", "alpha"]);

  const mapping = {
    position: positionTriplet,
    color: colorTriplet,
    opacity: opacityName,
  };

  const outputBuffer = dryRun ? null : Buffer.from(inputBuffer);
  const sourceView = new DataView(inputBuffer.buffer, inputBuffer.byteOffset, inputBuffer.byteLength);
  const targetView = dryRun
    ? null
    : new DataView(outputBuffer.buffer, outputBuffer.byteOffset, outputBuffer.byteLength);
  const littleEndian = header.format === "binary_little_endian";

  let changedVertices = 0;
  let touchedVertices = 0;
  const sampleChanges = [];
  const maxSampleChanges = 20;

  for (let i = 0; i < vertex.count; i += 1) {
    const rowOffset = header.headerEndOffset + i * rowSize;
    const state = {};

    for (const prop of properties) {
      const meta = propertyOffsets.get(prop.name);
      const [value] = readScalar(sourceView, rowOffset + meta.offset, meta.type, littleEndian);
      state[prop.name] = value;
    }

    let vertexChanged = false;
    let vertexTouched = false;
    for (const op of operations) {
      const beforeInside = op.stats.insideCount;
      const changed = applyOperationToVertex(op, state, mapping);
      if (op.stats.insideCount > beforeInside) {
        vertexTouched = true;
      }
      if (changed) {
        vertexChanged = true;
      }
    }

    if (vertexTouched) {
      touchedVertices += 1;
    }
    if (!vertexChanged) {
      continue;
    }

    changedVertices += 1;
    if (sampleChanges.length < maxSampleChanges) {
      sampleChanges.push({
        index: i,
        position: positionTriplet.map((name) => state[name]),
      });
    }

    if (dryRun) {
      continue;
    }

    for (const prop of properties) {
      const meta = propertyOffsets.get(prop.name);
      const clamped = clampByType(meta.type, state[prop.name]);
      writeScalar(targetView, rowOffset + meta.offset, meta.type, clamped, littleEndian);
    }
  }

  return {
    outputBuffer,
    summary: {
      vertexCount: vertex.count,
      touchedVertices,
      changedVertices,
      sampleChangedVertices: sampleChanges,
      mapping,
      operations: operations.map((op) => ({
        id: op.id,
        mode: op.mode,
        shape: op.shape,
        insideCount: op.stats.insideCount,
        changedCount: op.stats.changedCount,
      })),
    },
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = path.resolve(args.inputPath);
  const planPath = path.resolve(args.planPath);
  if (!fs.existsSync(inputPath)) fail(`Input file does not exist: ${inputPath}`);
  if (!fs.existsSync(planPath)) fail(`Plan file does not exist: ${planPath}`);

  const planObj = JSON.parse(fs.readFileSync(planPath, "utf8"));
  const operations = parsePlan(planObj);

  const inputBuffer = fs.readFileSync(inputPath);
  const header = parseHeader(inputBuffer);
  if (!["binary_little_endian", "binary_big_endian"].includes(header.format)) {
    fail(`Unsupported format for brush edits: ${header.format}. Use binary PLY.`);
  }

  const { outputBuffer, summary } = processBinaryPly(inputBuffer, header, operations, args.dryRun);

  const report = {
    generatedAt: new Date().toISOString(),
    input: inputPath,
    output: args.dryRun ? null : path.resolve(args.outputPath),
    format: header.format,
    plan: {
      operationCount: operations.length,
    },
    summary,
  };

  if (!args.dryRun) {
    const outputPath = path.resolve(args.outputPath);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, outputBuffer);
    console.error(`[ply-brush] Wrote edited PLY: ${outputPath}`);
  } else {
    console.error("[ply-brush] Dry run complete. No file written.");
  }

  if (args.reportPath) {
    const reportPath = path.resolve(args.reportPath);
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.error(`[ply-brush] Wrote report: ${reportPath}`);
  } else {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  }
}

try {
  main();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
