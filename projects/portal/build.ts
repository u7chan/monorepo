#!/usr/bin/env bun
import plugin from "bun-plugin-tailwind";
import { existsSync } from "fs";
import { mkdir, readdir, rename, rm } from "fs/promises";
import path from "path";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`
🏗️  Bun Build Script

Usage: bun run build.ts [options]

Common Options:
  --outdir <path>          Output directory (default: "dist")
  --minify                 Enable minification (or --minify.whitespace, --minify.syntax, etc)
  --sourcemap <type>      Sourcemap type: none|linked|inline|external
  --target <target>        Build target: browser|bun|node
  --format <format>        Output format: esm|cjs|iife
  --splitting              Enable code splitting
  --packages <type>        Package handling: bundle|external
  --public-path <path>     Public path for assets
  --env <mode>             Environment handling: inline|disable|prefix*
  --conditions <list>      Package.json export conditions (comma separated)
  --external <list>        External packages (comma separated)
  --banner <text>          Add banner text to output
  --footer <text>          Add footer text to output
  --define <obj>           Define global constants (e.g. --define.VERSION=1.0.0)
  --help, -h               Show this help message

Example:
  bun run build.ts --outdir=dist --minify --sourcemap=linked --external=react,react-dom
`);
  process.exit(0);
}

const toCamelCase = (str: string): string => str.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());

const parseValue = (value: string): any => {
  if (value === "true") return true;
  if (value === "false") return false;

  if (/^\d+$/.test(value)) return parseInt(value, 10);
  if (/^\d*\.\d+$/.test(value)) return parseFloat(value);

  if (value.includes(",")) return value.split(",").map(v => v.trim());

  return value;
};

function parseArgs(): Partial<Bun.BuildConfig> {
  const config: Record<string, unknown> = {};
  const args = process.argv.slice(2);

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (!arg.startsWith("--")) continue;

    if (arg.startsWith("--no-")) {
      const key = toCamelCase(arg.slice(5));
      config[key] = false;
      continue;
    }

    if (!arg.includes("=") && (i === args.length - 1 || args[i + 1]?.startsWith("--"))) {
      const key = toCamelCase(arg.slice(2));
      config[key] = true;
      continue;
    }

    let key: string;
    let value: string;

    if (arg.includes("=")) {
      [key, value] = arg.slice(2).split("=", 2) as [string, string];
    } else {
      key = arg.slice(2);
      value = args[++i] ?? "";
    }

    key = toCamelCase(key);

    if (key.includes(".")) {
      const parts = key.split(".");
      if (parts.length > 2) {
        console.warn(
          `Warning: Deeply nested option "${key}" is not supported. Only single-level nesting (e.g., --minify.whitespace) is allowed.`,
        );
        continue;
      }
      const parentKey = parts[0]!;
      const childKey = parts[1]!;
      const existing = config[parentKey];
      if (typeof existing !== "object" || existing === null || Array.isArray(existing)) {
        config[parentKey] = {};
      }
      (config[parentKey] as Record<string, unknown>)[childKey] = parseValue(value);
    } else {
      config[key] = parseValue(value);
    }
  }

  return config as Partial<Bun.BuildConfig>;
}

const formatFileSize = (bytes: number): string => {
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  return `${size.toFixed(2)} ${units[unitIndex]}`;
};

console.log("\n🚀 Starting build process...\n");

const cliConfig = parseArgs();
const outdir = cliConfig.outdir || path.join(process.cwd(), "dist");

if (existsSync(outdir)) {
  console.log(`🗑️ Cleaning previous build at ${outdir}`);
  await rm(outdir, { recursive: true, force: true });
}

const start = performance.now();
const allOutputs: { File: string; Type: string; Size: string }[] = [];

// Create directories
const staticOutdir = path.join(outdir, "static");
await mkdir(staticOutdir, { recursive: true });

// Build server first (with HTML as external to avoid conflicts)
console.log("🔧 Building server...");
const serverResult = await Bun.build({
  entrypoints: [path.resolve("src/index.ts")],
  outdir,
  naming: "[name]-[hash].js",
  minify: true,
  target: "bun",
  sourcemap: "linked",
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  external: ["bun"],
});

for (const output of serverResult.outputs) {
  allOutputs.push({
    File: path.relative(process.cwd(), output.path),
    Type: output.kind === "entry-point" ? "server" : output.kind,
    Size: formatFileSize(output.size),
  });
}

// Rename server entry point to index.js (remove hash)
// Find the largest index-*.js file (the server, not the HTML bundle)
const files = await readdir(outdir);
const indexFiles = files
  .filter(f => f.match(/^index-[a-z0-9]+\.js$/) && !f.endsWith(".map"))
  .map(f => ({ name: f, stats: Bun.file(path.join(outdir, f)) }));

let largestFile = null;
let largestSize = 0;
for (const f of indexFiles) {
  const size = await f.stats.size;
  if (size > largestSize) {
    largestSize = size;
    largestFile = f.name;
  }
}

if (largestFile) {
  await rename(
    path.join(outdir, largestFile),
    path.join(outdir, "index.js")
  );
  // Also rename sourcemap if it exists
  const mapFile = largestFile + ".map";
  if (files.includes(mapFile)) {
    await rename(
      path.join(outdir, mapFile),
      path.join(outdir, "index.js.map")
    );
  }
}



// Build frontend (HTML files) to static subdirectory
const htmlEntrypoints = [...new Bun.Glob("**.html").scanSync("src")]
  .map(a => path.resolve("src", a))
  .filter(dir => !dir.includes("node_modules"));
console.log(`📄 Found ${htmlEntrypoints.length} HTML ${htmlEntrypoints.length === 1 ? "file" : "files"} to process\n`);

if (htmlEntrypoints.length > 0) {
  const frontendResult = await Bun.build({
    entrypoints: htmlEntrypoints,
    outdir: staticOutdir,
    plugins: [plugin],
    minify: true,
    target: "browser",
    sourcemap: "linked",
    publicPath: "/static/",
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
    },
  });

  for (const output of frontendResult.outputs) {
    allOutputs.push({
      File: path.relative(process.cwd(), output.path),
      Type: output.kind,
      Size: formatFileSize(output.size),
    });
  }
}

const end = performance.now();

console.table(allOutputs);
const buildTime = (end - start).toFixed(2);

console.log(`\n✅ Build completed in ${buildTime}ms\n`);
