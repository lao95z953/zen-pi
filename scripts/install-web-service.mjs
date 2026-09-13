import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  origin: { type: 'string' }, 'tailscale-user': { type: 'string' }, workspace: { type: 'string' }, vault: { type: 'string' },
  'dry-run': { type: 'boolean', default: false },
} });
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(root, 'web/server.mjs');
if (!existsSync(script)) throw new Error('尚未找到 Web server，請先完成 checkout／更新。');
if (!!values.origin !== !!values['tailscale-user']) throw new Error('Tailscale 入口需同時提供 --origin 與 --tailscale-user。');
if (values.origin) {
  const url = new URL(values.origin);
  if (url.protocol !== 'https:' || url.origin !== values.origin || url.username || url.password) throw new Error('--origin 必須是 HTTPS origin，不能帶路徑。');
}
const configDir = join(homedir(), '.config/zen-pi-web');
const serviceDir = join(homedir(), '.config/systemd/user');
const envPath = join(configDir, 'environment');
const servicePath = join(serviceDir, 'zen-pi-web.service');
const workspace = resolve(values.workspace || homedir());
if (!existsSync(workspace) || !lstatSync(workspace).isDirectory()) throw new Error('workspace 必須是已存在的目錄。');
const vault = values.vault ? resolve(values.vault) : '';
if (vault && (!existsSync(vault) || !lstatSync(vault).isDirectory() || !existsSync(join(vault, '.obsidian')))) {
  throw new Error('vault 必須是已存在的 Obsidian vault。');
}
const quote = value => {
  if (/[\r\n\0]/.test(value)) throw new Error('設定值不能包含控制字元。');
  return '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';
};
const unitQuote = value => quote(value.replaceAll('%', '%%'));
const environment = [
  `PATH=${quote(`${join(homedir(), '.local/bin')}:/usr/local/bin:/usr/bin:/bin`)}`,
  'PI_WEB_PORT=4318',
  `PI_WEB_WORKSPACE=${quote(workspace)}`,
  `PI_STUDY_VAULT=${quote(vault)}`,
  `PI_WEB_PUBLIC_ORIGIN=${quote(values.origin || '')}`,
  `PI_WEB_TAILSCALE_USER=${quote(values['tailscale-user'] || '')}`,
].join('\n') + '\n';
const unit = `[Unit]
Description=Zen Pi Web UI
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${workspace.replaceAll('%', '%%')}
EnvironmentFile=${envPath.replaceAll('%', '%%')}
ExecStart=${unitQuote(process.execPath)} ${unitQuote(script)}
Restart=on-failure
RestartSec=3
KillMode=control-group
TimeoutStopSec=15
UMask=0077

[Install]
WantedBy=default.target
`;
if (values['dry-run']) {
  console.log(`${servicePath}\n${unit}\n${envPath}\n${environment}`);
} else {
  for (const dir of [configDir, serviceDir]) mkdirSync(dir, { recursive: true });
  for (const [file, content] of [[envPath, environment], [servicePath, unit]]) {
    if (existsSync(file)) {
      if (!lstatSync(file).isFile()) throw new Error(`拒絕覆蓋非普通檔案：${file}`);
      const backup = `${file}.before-${Date.now()}`;
      renameSync(file, backup);
      console.log(`已備份 ${backup}`);
    }
    writeFileSync(file, content, { mode: 0o600, flag: 'wx' });
  }
  for (const args of [['--user', 'daemon-reload'], ['--user', 'enable', 'zen-pi-web.service'], ['--user', 'restart', 'zen-pi-web.service']]) {
    execFileSync('systemctl', args, { stdio: 'inherit' });
  }
  console.log('Pi Web 使用者服務已啟用。Tailscale Serve 需另行設定。');
}
