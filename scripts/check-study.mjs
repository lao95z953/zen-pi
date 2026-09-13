import { createRequire } from "node:module";
import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
const pi = join(globalRoot, "@earendil-works/pi-coding-agent");
const req = createRequire(join(pi, "package.json"));
const paths = { "@earendil-works/pi-coding-agent": [join(pi, "dist/index.d.ts")], "typebox": [req.resolve("typebox").replace(/\.mjs$/, ".d.mts")] };
const files = ["extensions/study", "extensions/subagents"].flatMap(dir => readdirSync(dir).filter(f => f.endsWith(".ts")).map(f => resolve(dir, f)));
const temp = mkdtempSync(join(tmpdir(), "pi-study-types-"));
try {
  const config = join(temp, "tsconfig.json");
  writeFileSync(config, JSON.stringify({ files, compilerOptions: { target: "ES2022", module: "ESNext",
    moduleResolution: "bundler", noEmit: true, strict: true, skipLibCheck: true,
    types: ["node"], typeRoots: [resolve("node_modules/@types")], allowImportingTsExtensions: true, esModuleInterop: true, paths } }));
  const r = spawnSync(resolve("node_modules/.bin/tsc"), ["--project", config], { stdio: "inherit" });
  if (r.status !== 0) process.exitCode = 1;
  else console.log(`TypeScript: ${files.length} extension modules checked.`);
} finally { rmSync(temp, { recursive: true, force: true }); }
