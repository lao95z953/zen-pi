import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const vaultPath = process.argv[2] || process.env.PI_STUDY_VAULT;
if (!vaultPath) throw new Error("請提供 Obsidian vault 路徑，或設定 PI_STUDY_VAULT。");
const vault = realpathSync(vaultPath);
if (!existsSync(join(vault, ".obsidian"))) throw new Error("指定路徑不是已建立的 Obsidian vault。");
const source = join(dirname(fileURLToPath(import.meta.url)), "..", "obsidian", "pi-study-bridge");
const destination = join(vault, ".obsidian", "plugins", "pi-study-bridge");
// Refuse a symlink destination or an unrelated existing plugin.
mkdirSync(join(vault, ".obsidian", "plugins"), { recursive: true });
if (realpathSync(join(vault, ".obsidian", "plugins")) !== join(vault, ".obsidian", "plugins")) throw new Error("plugins 路徑是 symlink，請手動安裝。");
mkdirSync(destination, { recursive: true });
if (realpathSync(destination) !== destination) throw new Error("安裝目的地是 symlink，請手動安裝。");
const files = ["manifest.json", "main.js"];
for (const name of files) {
  const target = join(destination, name);
  if (existsSync(target) && (realpathSync(target) !== target || !readFileSync(target).equals(readFileSync(join(source, name))))) {
    throw new Error(`已有不同內容：${target}。未覆蓋，請先檢查。`);
  }
}
for (const name of files) copyFileSync(join(source, name), join(destination, name));
console.log(`已安裝到 ${destination}\n請到 Obsidian → 設定 → 社群外掛，啟用 Zen Pi Study Bridge。`);
