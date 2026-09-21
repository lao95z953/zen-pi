import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserHome } from '../browser/client.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const venv = join(browserHome(), 'venv');
async function run(command, args, env = process.env) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', env });
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
  });
}
await run('uv', ['sync', '--project', join(root, 'browser/laya'), '--locked', '--no-dev', '--no-install-project'], { ...process.env, UV_PROJECT_ENVIRONMENT: venv });
await run(join(venv, 'bin/python'), [join(root, 'browser/laya/worker.py'), '--download'], { ...process.env, USE_TF: '0', USE_FLAX: '0' });
console.log('Laya 已準備完成。browser 工具的 step 使用本機模型提出建議，不需要 Jev API key。');
