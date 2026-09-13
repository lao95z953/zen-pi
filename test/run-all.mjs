import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here).filter((f) => f.endsWith(".test.mjs")).sort();

let failed = 0;
for (const f of files) {
  console.log(`\n── ${f} ──`);
  const r = spawnSync(process.execPath, [join(here, f)], { stdio: "inherit" });
  if (r.status !== 0) failed++;
}

console.log(`\n${files.length - failed}/${files.length} 個測試檔通過`);
process.exit(failed === 0 ? 0 : 1);
