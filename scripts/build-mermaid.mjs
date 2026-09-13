import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const output = resolve('web/public/mermaid-vendor.js');
const result = await build({
  entryPoints: ['node_modules/mermaid/dist/mermaid.core.mjs'],
  bundle: true,
  format: 'esm',
  minify: true,
  target: 'es2022',
  legalComments: 'external',
  write: false,
  outfile: output,
});
const files = new Map(result.outputFiles.map(file => [file.path, file.contents]));
if (process.argv.includes('--check')) {
  for (const [path, content] of files) {
    const existing = await readFile(path).catch(() => null);
    if (!existing?.equals(content)) throw Error(`Mermaid bundle needs rebuilding: ${path}`);
  }
} else {
  for (const [path, content] of files) await writeFile(path, content);
}
