#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function findExecutable(name) {
  const candidates = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .flatMap((directory) => process.platform === "win32"
      ? [`${name}.cmd`, `${name}.exe`, name].map((file) => path.join(directory, file))
      : [path.join(directory, name)]);
  const executable = candidates.find((candidate) => {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
  if (!executable) throw new Error(`Required executable not found on PATH: ${name}`);
  return executable;
}

function findPackageRootFromExecutable(executable, expectedName) {
  let current = path.dirname(fs.realpathSync(executable));
  for (;;) {
    const manifest = path.join(current, "package.json");
    if (fs.existsSync(manifest)) {
      try {
        if (JSON.parse(fs.readFileSync(manifest, "utf8")).name === expectedName) return current;
      } catch {
        // Continue walking toward the package root.
      }
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`Could not locate ${expectedName} from ${executable}`);
}

function firstExisting(candidates, label) {
  const match = candidates.find((candidate) => fs.existsSync(candidate));
  if (!match) throw new Error(`Could not locate ${label}. Checked:\n${candidates.join("\n")}`);
  return match;
}

const piRoot = process.env.PI_CODING_AGENT_PACKAGE_ROOT
  ? path.resolve(process.env.PI_CODING_AGENT_PACKAGE_ROOT)
  : findPackageRootFromExecutable(findExecutable("pi"), "@earendil-works/pi-coding-agent");
const dependencies = path.join(piRoot, "node_modules");
const typebox = firstExisting([
  path.join(dependencies, "typebox", "build", "index.d.mts"),
  path.join(dependencies, "typebox", "build", "index.d.ts"),
], "Pi's TypeBox declarations");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workbench-typecheck-"));
const configPath = path.join(temporary, "tsconfig.json");
const config = {
  compilerOptions: {
    target: "ES2022",
    module: "NodeNext",
    moduleResolution: "NodeNext",
    strict: true,
    noEmit: true,
    allowImportingTsExtensions: true,
    skipLibCheck: true,
    types: ["node"],
    typeRoots: [path.join(dependencies, "@types")],
    baseUrl: root,
    paths: {
      "@earendil-works/pi-coding-agent": [path.join(piRoot, "dist", "index.d.ts")],
      "@earendil-works/pi-ai": [path.join(dependencies, "@earendil-works", "pi-ai", "dist", "index.d.ts")],
      "@earendil-works/pi-agent-core": [path.join(dependencies, "@earendil-works", "pi-agent-core", "dist", "index.d.ts")],
      "@earendil-works/pi-tui": [path.join(dependencies, "@earendil-works", "pi-tui", "dist", "index.d.ts")],
      typebox: [typebox],
    },
  },
  include: [path.join(root, "*.ts")],
  exclude: [path.join(root, "tests")],
};

try {
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  const result = spawnSync(findExecutable("tsc"), ["-p", configPath], {
    cwd: root,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  console.log("Pi Workbench strict TypeScript check passed.");
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
