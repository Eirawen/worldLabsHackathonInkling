#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const DEFAULT_SAMPLE_COUNT = 200;
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
  int64: "int64",
  uint64: "uint64",
  long: "int64",
  ulong: "uint64",
  longlong: "int64",
  ulonglong: "uint64",
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
  int64: 8,
  uint64: 8,
};

function usage() {
  return [
    "Usage:",
    "  node spz-tools/read_ply_for_llm.mjs <input.ply> [--out report.json] [--sample N] [--all-vertices] [--jsonl samples.jsonl]",
    "",
    "Examples:",
    "  node spz-tools/read_ply_for_llm.mjs /tmp/scene.ply",
    "  node spz-tools/read_ply_for_llm.mjs /tmp/scene.ply --sample 400 --out /tmp/scene.llm.json",
    "  node spz-tools/read_ply_for_llm.mjs /tmp/scene.ply --sample 300 --jsonl /tmp/scene.samples.jsonl",
  ].join("\n");
}

function fail(message) {
  console.error(`[ply-reader] ${message}`);
  process.exit(1);
}

function normalizeType(typeName) {
  const normalized = PLY_TYPE_ALIASES[typeName.toLowerCase()];
  if (!normalized) {
    throw new Error(`Unsupported PLY type: ${typeName}`);
  }
  return normalized;
}

function parseCli(argv) {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    console.log(usage());
    process.exit(0);
  }

  const options = {
    inputPath: null,
    outputPath: null,
    sampleCount: DEFAULT_SAMPLE_COUNT,
    allVertices: false,
    jsonlPath: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("-") && options.inputPath === null) {
      options.inputPath = token;
      continue;
    }

    if (token === "--out") {
      const value = argv[i + 1];
      if (!value) fail("--out requires a file path");
      options.outputPath = value;
      i += 1;
      continue;
    }

    if (token === "--sample") {
      const value = argv[i + 1];
      if (!value) fail("--sample requires an integer");
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed < 0) {
        fail("--sample must be a non-negative integer");
      }
      options.sampleCount = parsed;
      i += 1;
      continue;
    }

    if (token === "--all-vertices") {
      options.allVertices = true;
      continue;
    }

    if (token === "--jsonl") {
      const value = argv[i + 1];
      if (!value) fail("--jsonl requires a file path");
      options.jsonlPath = value;
      i += 1;
      continue;
    }

    fail(`Unknown argument: ${token}`);
  }

  if (!options.inputPath) {
    fail("Input .ply path is required.");
  }
  return options;
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
    throw new Error("PLY header terminator `end_header` not found.");
  }

  const headerText = buffer.slice(0, headerEndOffset).toString("utf8");
  const lines = headerText.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines[0] !== "ply") {
    throw new Error("Invalid PLY file: first line must be `ply`.");
  }

  const header = {
    format: null,
    version: null,
    comments: [],
    objInfo: [],
    elements: [],
    headerEndOffset,
  };

  let currentElement = null;
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    const tokens = line.trim().split(/\s+/);
    if (tokens.length === 0) {
      continue;
    }

    if (tokens[0] === "format") {
      header.format = tokens[1] ?? null;
      header.version = tokens[2] ?? null;
      continue;
    }

    if (tokens[0] === "comment") {
      header.comments.push(line.slice("comment".length).trim());
      continue;
    }

    if (tokens[0] === "obj_info") {
      header.objInfo.push(line.slice("obj_info".length).trim());
      continue;
    }

    if (tokens[0] === "element") {
      if (tokens.length < 3) {
        throw new Error(`Invalid element declaration: ${line}`);
      }
      currentElement = {
        name: tokens[1],
        count: Number.parseInt(tokens[2], 10),
        properties: [],
      };
      if (!Number.isFinite(currentElement.count) || currentElement.count < 0) {
        throw new Error(`Invalid element count in line: ${line}`);
      }
      header.elements.push(currentElement);
      continue;
    }

    if (tokens[0] === "property") {
      if (!currentElement) {
        throw new Error(`Property appears before element declaration: ${line}`);
      }
      if (tokens[1] === "list") {
        if (tokens.length < 5) {
          throw new Error(`Invalid list property declaration: ${line}`);
        }
        currentElement.properties.push({
          kind: "list",
          name: tokens[4],
          countType: normalizeType(tokens[2]),
          itemType: normalizeType(tokens[3]),
          rawCountType: tokens[2],
          rawItemType: tokens[3],
        });
      } else {
        if (tokens.length < 3) {
          throw new Error(`Invalid scalar property declaration: ${line}`);
        }
        currentElement.properties.push({
          kind: "scalar",
          name: tokens[2],
          type: normalizeType(tokens[1]),
          rawType: tokens[1],
        });
      }
      continue;
    }
  }

  if (!header.format) {
    throw new Error("PLY header is missing a format line.");
  }

  return header;
}

function buildSampleIndices(totalCount, desiredCount, allVertices) {
  if (allVertices || desiredCount >= totalCount) {
    return Array.from({ length: totalCount }, (_, index) => index);
  }
  if (desiredCount <= 0 || totalCount <= 0) {
    return [];
  }
  if (desiredCount === 1) {
    return [0];
  }

  const seen = new Set();
  for (let i = 0; i < desiredCount; i += 1) {
    const index = Math.floor((i * (totalCount - 1)) / (desiredCount - 1));
    seen.add(index);
  }
  return [...seen].sort((a, b) => a - b);
}

function toSafeNumberOrString(bigIntValue) {
  const minSafe = BigInt(Number.MIN_SAFE_INTEGER);
  const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
  if (bigIntValue >= minSafe && bigIntValue <= maxSafe) {
    return Number(bigIntValue);
  }
  return bigIntValue.toString();
}

function readScalarBinary(view, offset, type, littleEndian) {
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
    case "int64":
      return [toSafeNumberOrString(view.getBigInt64(offset, littleEndian)), offset + 8];
    case "uint64":
      return [toSafeNumberOrString(view.getBigUint64(offset, littleEndian)), offset + 8];
    default:
      throw new Error(`Unsupported binary type ${type}`);
  }
}

function numericOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function initScalarStats(elementProperties) {
  const stats = {};
  for (const property of elementProperties) {
    if (property.kind !== "scalar") {
      continue;
    }
    stats[property.name] = {
      min: Number.POSITIVE_INFINITY,
      max: Number.NEGATIVE_INFINITY,
      sum: 0,
      count: 0,
    };
  }
  return stats;
}

function finalizeScalarStats(statsState) {
  const result = {};
  for (const [propertyName, state] of Object.entries(statsState)) {
    if (state.count === 0) {
      continue;
    }
    result[propertyName] = {
      min: state.min,
      max: state.max,
      mean: state.sum / state.count,
    };
  }
  return result;
}

function updateBounds(bounds, x, y, z) {
  if (x < bounds.min.x) bounds.min.x = x;
  if (y < bounds.min.y) bounds.min.y = y;
  if (z < bounds.min.z) bounds.min.z = z;
  if (x > bounds.max.x) bounds.max.x = x;
  if (y > bounds.max.y) bounds.max.y = y;
  if (z > bounds.max.z) bounds.max.z = z;
}

function inferVertexSchema(propertyNames) {
  const originalByLower = new Map();
  for (const name of propertyNames) {
    originalByLower.set(name.toLowerCase(), name);
  }

  const pickTriplet = (...candidates) => {
    for (const candidate of candidates) {
      if (candidate.every((name) => originalByLower.has(name))) {
        return candidate.map((name) => originalByLower.get(name));
      }
    }
    return null;
  };

  const pickQuartet = (...candidates) => {
    for (const candidate of candidates) {
      if (candidate.every((name) => originalByLower.has(name))) {
        return candidate.map((name) => originalByLower.get(name));
      }
    }
    return null;
  };

  const pickSingle = (...candidates) => {
    for (const name of candidates) {
      if (originalByLower.has(name)) {
        return originalByLower.get(name);
      }
    }
    return null;
  };

  const position = pickTriplet(["x", "y", "z"]);
  const normal = pickTriplet(["nx", "ny", "nz"]);
  const color = pickTriplet(["red", "green", "blue"], ["r", "g", "b"], ["f_dc_0", "f_dc_1", "f_dc_2"]);
  const scale = pickTriplet(["scale_0", "scale_1", "scale_2"], ["sx", "sy", "sz"]);
  const rotation = pickQuartet(["rot_0", "rot_1", "rot_2", "rot_3"], ["qx", "qy", "qz", "qw"]);
  const opacity = pickSingle("opacity", "alpha");

  const lowerNames = new Set(propertyNames.map((value) => value.toLowerCase()));
  const likelyGaussianSplat =
    lowerNames.has("f_dc_0") &&
    lowerNames.has("f_dc_1") &&
    lowerNames.has("f_dc_2") &&
    lowerNames.has("opacity") &&
    lowerNames.has("scale_0") &&
    lowerNames.has("rot_0");

  return {
    likelyGaussianSplat,
    position,
    normal,
    color,
    opacity,
    scale,
    rotation,
  };
}

function buildCanonicalVertex(rawVertex, schema) {
  const canonical = {};
  if (schema.position) {
    canonical.position = schema.position.map((name) => rawVertex[name]);
  }
  if (schema.normal) {
    canonical.normal = schema.normal.map((name) => rawVertex[name]);
  }
  if (schema.color) {
    canonical.color = schema.color.map((name) => rawVertex[name]);
  }
  if (schema.opacity) {
    canonical.opacity = rawVertex[schema.opacity];
  }
  if (schema.scale) {
    canonical.scale = schema.scale.map((name) => rawVertex[name]);
  }
  if (schema.rotation) {
    canonical.rotation = schema.rotation.map((name) => rawVertex[name]);
  }
  return canonical;
}

function parseAsciiBody(buffer, offset) {
  const body = buffer.slice(offset).toString("utf8");
  const tokens = [];
  let tokenStart = -1;
  for (let i = 0; i < body.length; i += 1) {
    const charCode = body.charCodeAt(i);
    const isWhitespace = charCode <= 32;
    if (isWhitespace) {
      if (tokenStart !== -1) {
        tokens.push(body.slice(tokenStart, i));
        tokenStart = -1;
      }
      continue;
    }
    if (tokenStart === -1) {
      tokenStart = i;
    }
  }
  if (tokenStart !== -1) {
    tokens.push(body.slice(tokenStart));
  }
  return tokens;
}

function parsePly(inputBuffer, parsedHeader, options) {
  const header = parsedHeader;
  const isBinaryLittle = header.format === "binary_little_endian";
  const isBinaryBig = header.format === "binary_big_endian";
  const isAscii = header.format === "ascii";
  if (!isBinaryLittle && !isBinaryBig && !isAscii) {
    throw new Error(`Unsupported PLY format: ${header.format}`);
  }

  const vertexElement = header.elements.find((element) => element.name === "vertex") ?? null;
  const vertexPropertyNames = vertexElement ? vertexElement.properties.map((prop) => prop.name) : [];
  const schema = inferVertexSchema(vertexPropertyNames);
  const sampleIndices = vertexElement
    ? buildSampleIndices(vertexElement.count, options.sampleCount, options.allVertices)
    : [];

  const sampledVertices = [];
  let sampleCursor = 0;

  const positionPropNames = schema.position;
  const bounds = positionPropNames
    ? {
        min: { x: Number.POSITIVE_INFINITY, y: Number.POSITIVE_INFINITY, z: Number.POSITIVE_INFINITY },
        max: { x: Number.NEGATIVE_INFINITY, y: Number.NEGATIVE_INFINITY, z: Number.NEGATIVE_INFINITY },
      }
    : null;

  const vertexStatsState = vertexElement ? initScalarStats(vertexElement.properties) : {};

  let binaryOffset = header.headerEndOffset;
  let asciiTokens = null;
  let asciiCursor = 0;
  if (isAscii) {
    asciiTokens = parseAsciiBody(inputBuffer, header.headerEndOffset);
  }

  const view = new DataView(inputBuffer.buffer, inputBuffer.byteOffset, inputBuffer.byteLength);

  for (const element of header.elements) {
    const isVertexElement = element.name === "vertex";

    for (let rowIndex = 0; rowIndex < element.count; rowIndex += 1) {
      const shouldCapture =
        isVertexElement &&
        sampleCursor < sampleIndices.length &&
        rowIndex === sampleIndices[sampleCursor];

      const rowRecord = shouldCapture ? {} : null;

      for (const property of element.properties) {
        if (property.kind === "scalar") {
          let value;
          if (isAscii) {
            if (asciiCursor >= asciiTokens.length) {
              throw new Error("ASCII PLY ended unexpectedly while reading scalar property.");
            }
            value = Number(asciiTokens[asciiCursor]);
            asciiCursor += 1;
          } else {
            const littleEndian = isBinaryLittle;
            [value, binaryOffset] = readScalarBinary(view, binaryOffset, property.type, littleEndian);
          }

          if (isVertexElement) {
            const numericValue = numericOrNull(value);
            if (numericValue !== null && property.name in vertexStatsState) {
              const state = vertexStatsState[property.name];
              if (numericValue < state.min) state.min = numericValue;
              if (numericValue > state.max) state.max = numericValue;
              state.sum += numericValue;
              state.count += 1;
            }
            if (rowRecord) {
              rowRecord[property.name] = value;
            }
          }
          continue;
        }

        if (property.kind === "list") {
          let listCount;
          if (isAscii) {
            if (asciiCursor >= asciiTokens.length) {
              throw new Error("ASCII PLY ended unexpectedly while reading list count.");
            }
            listCount = Number.parseInt(asciiTokens[asciiCursor], 10);
            asciiCursor += 1;
          } else {
            const littleEndian = isBinaryLittle;
            const countValue = readScalarBinary(view, binaryOffset, property.countType, littleEndian);
            listCount = Number(countValue[0]);
            binaryOffset = countValue[1];
          }

          if (!Number.isFinite(listCount) || listCount < 0) {
            throw new Error(`Invalid list count for property ${property.name}`);
          }

          if (rowRecord) {
            rowRecord[property.name] = [];
          }

          if (!isAscii && !rowRecord) {
            const itemSize = PLY_TYPE_SIZE[property.itemType];
            binaryOffset += listCount * itemSize;
            continue;
          }

          for (let i = 0; i < listCount; i += 1) {
            let listValue;
            if (isAscii) {
              if (asciiCursor >= asciiTokens.length) {
                throw new Error("ASCII PLY ended unexpectedly while reading list item.");
              }
              listValue = Number(asciiTokens[asciiCursor]);
              asciiCursor += 1;
            } else {
              const littleEndian = isBinaryLittle;
              [listValue, binaryOffset] = readScalarBinary(view, binaryOffset, property.itemType, littleEndian);
            }
            if (rowRecord) {
              rowRecord[property.name].push(listValue);
            }
          }
        }
      }

      if (isVertexElement && rowRecord) {
        if (positionPropNames) {
          const x = Number(rowRecord[positionPropNames[0]]);
          const y = Number(rowRecord[positionPropNames[1]]);
          const z = Number(rowRecord[positionPropNames[2]]);
          if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
            updateBounds(bounds, x, y, z);
          }
        }

        sampledVertices.push({
          index: rowIndex,
          canonical: buildCanonicalVertex(rowRecord, schema),
          properties: rowRecord,
        });
        sampleCursor += 1;
      } else if (isVertexElement && positionPropNames && positionPropNames.every((name) => name in vertexStatsState)) {
        // Bounds and centroid are derived from x/y/z stats when the row isn't captured.
      }
    }
  }

  let finalizedBounds = null;
  let centroid = null;
  if (positionPropNames) {
    const xStats = vertexStatsState[positionPropNames[0]];
    const yStats = vertexStatsState[positionPropNames[1]];
    const zStats = vertexStatsState[positionPropNames[2]];
    if (xStats?.count > 0 && yStats?.count > 0 && zStats?.count > 0) {
      finalizedBounds = {
        min: { x: xStats.min, y: yStats.min, z: zStats.min },
        max: { x: xStats.max, y: yStats.max, z: zStats.max },
      };
      centroid = {
        x: xStats.sum / xStats.count,
        y: yStats.sum / yStats.count,
        z: zStats.sum / zStats.count,
      };
    } else if (bounds && Number.isFinite(bounds.min.x)) {
      finalizedBounds = bounds;
    }
  }

  const vertexSummary = vertexElement
    ? {
        count: vertexElement.count,
        propertyCount: vertexElement.properties.length,
        properties: vertexElement.properties.map((property) =>
          property.kind === "scalar"
            ? { kind: "scalar", name: property.name, type: property.type }
            : {
                kind: "list",
                name: property.name,
                countType: property.countType,
                itemType: property.itemType,
              },
        ),
        inferredSchema: schema,
        bounds: finalizedBounds,
        centroid,
        scalarStats: finalizeScalarStats(vertexStatsState),
        sample: {
          strategy: options.allVertices ? "all_vertices" : "evenly_spaced",
          requestedCount: options.allVertices ? vertexElement.count : options.sampleCount,
          actualCount: sampledVertices.length,
          vertices: sampledVertices,
        },
      }
    : null;

  return {
    header: {
      format: header.format,
      version: header.version,
      comments: header.comments,
      objInfo: header.objInfo,
      elements: header.elements.map((element) => ({
        name: element.name,
        count: element.count,
        properties: element.properties.map((property) =>
          property.kind === "scalar"
            ? { kind: "scalar", name: property.name, type: property.type }
            : { kind: "list", name: property.name, countType: property.countType, itemType: property.itemType },
        ),
      })),
    },
    vertex: vertexSummary,
  };
}

function main() {
  const options = parseCli(process.argv.slice(2));
  const inputPath = path.resolve(options.inputPath);
  if (!fs.existsSync(inputPath)) {
    fail(`Input file does not exist: ${inputPath}`);
  }

  const fileBuffer = fs.readFileSync(inputPath);
  const fileStats = fs.statSync(inputPath);
  const parsedHeader = parseHeader(fileBuffer);
  const parsedBody = parsePly(fileBuffer, parsedHeader, options);

  const report = {
    generatedAt: new Date().toISOString(),
    sourceFile: inputPath,
    fileSizeBytes: fileStats.size,
    ...parsedBody,
  };

  const outputText = JSON.stringify(report, null, 2);
  if (options.outputPath) {
    const outputPath = path.resolve(options.outputPath);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, outputText);
    console.error(`[ply-reader] Report written: ${outputPath}`);
  } else {
    process.stdout.write(outputText);
    process.stdout.write("\n");
  }

  if (options.jsonlPath && report.vertex?.sample?.vertices) {
    const jsonlPath = path.resolve(options.jsonlPath);
    fs.mkdirSync(path.dirname(jsonlPath), { recursive: true });
    const lines = report.vertex.sample.vertices.map((vertex) => JSON.stringify(vertex)).join("\n");
    fs.writeFileSync(jsonlPath, `${lines}\n`);
    console.error(`[ply-reader] JSONL samples written: ${jsonlPath}`);
  }
}

try {
  main();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
