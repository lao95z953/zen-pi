import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/** KaTeX ships no banner comment for esbuild to extract, so its MIT notice is copied verbatim. */
const bundles = [
  { entryPoint: 'node_modules/mermaid/dist/mermaid.core.mjs', outfile: resolve('web/public/mermaid-vendor.js') },
  { entryPoint: 'node_modules/katex/dist/katex.mjs', outfile: resolve('web/public/katex-vendor.js'), license: 'node_modules/katex/LICENSE' },
];
const files = new Map();
for (const { entryPoint, outfile, license } of bundles) {
  const result = await build({
    entryPoints: [entryPoint],
    bundle: true,
    format: 'esm',
    minify: true,
    target: 'es2022',
    legalComments: 'external',
    write: false,
    outfile,
  });
  for (const file of result.outputFiles) files.set(file.path, file.contents);
  if (license) files.set(`${outfile}.LEGAL.txt`, await readFile(license));
}
if (process.argv.includes('--check')) {
  for (const [path, content] of files) {
    const existing = await readFile(path).catch(() => null);
    if (!existing?.equals(content)) throw Error(`Vendor bundle needs rebuilding: ${path}`);
  }
} else {
  for (const [path, content] of files) await writeFile(path, content);
}
