import { lstatSync, realpathSync, mkdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep, parse } from "node:path";
import { readNote, type Note } from "./notes.ts";

export const WIKI_DIR = "07-Agent-Wiki";
/** String callers retain the old vault/07-Agent-Wiki layout. */
export type WikiStorage = string | { directory: string; sourceVault?: string };
export const storageDirectory = (storage: WikiStorage) => typeof storage === "string"
  ? join(realpathSync(storage), WIKI_DIR) : storage.directory;

/** Check every existing ancestor, including the mount itself, before creating or writing. */
export function checkedDirectory(directory: string, create = false): string {
  if (!isAbsolute(directory) || /[\0\r\n]/.test(directory)) throw new Error("Wiki 必須使用完整的本機資料夾路徑。");
  const absolute = resolve(directory);
  let parent = parse(absolute).root;
  for (const part of relative(parent, absolute).split(sep).filter(Boolean)) {
    parent = join(parent, part);
    try {
      const info = lstatSync(parent);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Wiki 路徑不能包含 symlink 或一般檔案。");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  if (create) mkdirSync(absolute, { recursive: true, mode: 0o700 });
  return absolute;
}

export function wikiPath(storage: WikiStorage, ...parts: string[]) {
  const base = checkedDirectory(storageDirectory(storage)), path = join(base, ...parts);
  const scoped = relative(base, path);
  if (scoped === ".." || scoped.startsWith(`..${sep}`) || isAbsolute(scoped)) throw new Error("Invalid wiki path");
  let parent = base;
  for (const part of scoped.split(sep).filter(Boolean)) {
    parent = join(parent, part);
    try { if (lstatSync(parent).isSymbolicLink()) throw new Error("Wiki 路徑含 symlink，停止讀寫。"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return path;
}

export const isWikiNote = (path: string) => path.startsWith(`${WIKI_DIR}/`);
/** The legacy prefix is a logical tool path, independent of the mounted directory. */
export function readStoredNote(storage: WikiStorage, path: string, sourceVault?: string): Note {
  if (isWikiNote(path)) {
    const relativePath = path.slice(WIKI_DIR.length + 1);
    const note = readNote(storageDirectory(storage), wikiPath(storage, relativePath));
    return { ...note, path: `${WIKI_DIR}/${note.path}` };
  }
  const vault = sourceVault || (typeof storage === "string" ? storage : storage.sourceVault);
  if (!vault) throw new Error("尚未設定來源筆記庫，請設定 PI_STUDY_VAULT；LLM Wiki 掛載不會改變來源筆記庫。");
  return readNote(vault, path);
}

export const receiptPath = (storage: WikiStorage, path: string) => typeof storage === "string"
  ? `${WIKI_DIR}/${path}` : wikiPath(storage, path);
