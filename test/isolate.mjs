import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Every test process gets its own settings, including tests launched directly.
// Never inherit a developer's Wiki mount or fall back to ~/.pi/agent/ronny.json.
const root = mkdtempSync(join(tmpdir(), 'zen-pi-test-settings-'));
const config = join(root, 'ronny.json');
writeFileSync(config, '{}\n', { mode: 0o600 });
mkdirSync(join(root, 'notes'));
process.env.PI_RONNY_CONFIG = config;
process.env.PI_LLM_WIKI = join(root, 'wiki');
process.env.PI_STUDY_VAULT = join(root, 'notes');
process.env.PI_BROWSER_HOME = join(root, 'browser');
delete process.env.PI_BROWSER_PYTHON;
process.once('exit', () => rmSync(root, { recursive: true, force: true }));
