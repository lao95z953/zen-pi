import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const destination = resolve(process.argv[2] || '/tmp/zen-pi-browser-bridge.xpi');
mkdirSync(dirname(destination), { recursive: true });
execFileSync('python3', ['-c', 'import pathlib,sys,zipfile; root=pathlib.Path(sys.argv[1]); z=zipfile.ZipFile(sys.argv[2],"w",zipfile.ZIP_DEFLATED); [z.write(p,p.relative_to(root)) for p in sorted(root.rglob("*")) if p.is_file()]; z.close()', resolve(root, 'browser/addon'), destination]);
console.log(destination);
