import './isolate.mjs';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir, hostname } from 'node:os';
import { test, assert, assertIncludes, report } from './harness.mjs';

const runner = resolve('eval/run.py');
const run = args => spawnSync('python3', [runner, ...args], { encoding: 'utf8', timeout: 10000 });
function protocol(events, { waitTurn = true, timeout = 2 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-eval-rpc-'));
  try {
    const fake = join(dir, 'fake.py'), driver = join(dir, 'driver.py');
    writeFileSync(fake, `import json, sys, time
steps = json.loads(sys.argv[1])
request = json.loads(sys.stdin.readline())
for step in steps:
    if 'sleep' in step:
        time.sleep(step['sleep'])
        continue
    if 'readUI' in step:
        reply = json.loads(sys.stdin.readline())
        step = {'type': 'ui_checked', 'cancelled': reply.get('cancelled'), 'responseType': reply.get('type')}
    if step.get('id') == '@request':
        step['id'] = request['id']
    print(json.dumps(step, ensure_ascii=False), flush=True)
`);
    writeFileSync(driver, `import json, os, runpy, sys
Rpc = runpy.run_path(sys.argv[1])['Rpc']
rpc = Rpc([sys.executable, '-u', sys.argv[2], sys.argv[3]], os.environ, os.path.dirname(sys.argv[2]), float(sys.argv[5]))
try:
    value = rpc.request('prompt', message='synthetic protocol fixture', wait_turn=sys.argv[4] == 'true')
    print(json.dumps({'ok': True, 'value': value, 'events': rpc.events}))
except Exception as error:
    print(json.dumps({'ok': False, 'error': str(error), 'errorType': type(error).__name__, 'events': rpc.events}))
finally:
    rpc.close()
`);
    const result = spawnSync('python3', [driver, runner, fake, JSON.stringify(events), String(waitTurn), String(timeout)], { encoding: 'utf8', timeout: 10000 });
    assert(result.status === 0, result.stderr);
    return JSON.parse(result.stdout);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
await test('評估題組可離線驗證，不呼叫 Pi 或模型', () => {
  const result = run(['--validate']);
  assert(result.status === 0, result.stderr);
  assertIncludes(result.stdout, 'Validated 8 synthetic cases');
  assertIncludes(result.stdout, 'no model calls');
});
await test('真正評估限制執行主機，且要求明確選擇模型', () => {
  const host = run(['--workstation-host', 'deliberately-not-this-host']);
  assert(host.status === 2);
  assertIncludes(host.stderr, 'must run on Workstation');
  const model = run(['--workstation-host', hostname()]);
  assert(model.status === 2);
  assertIncludes(model.stderr, 'Choose --provider and --model explicitly');
});
await test('評估檔案與案例 ID 不接受跳脫輸出目錄的路徑', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-eval-suite-'));
  try {
    const suite = JSON.parse(readFileSync(resolve('eval/tasks.json'), 'utf8'));
    const file = join(dir, 'suite.json');
    suite.cases[0].id = '../../escape';
    writeFileSync(file, JSON.stringify(suite));
    assert(run(['--validate', '--suite', file]).status !== 0);
    suite.cases[0].id = 'valid-id';
    suite.notes['../escape.md'] = 'outside';
    writeFileSync(file, JSON.stringify(suite));
    assert(run(['--validate', '--suite', file]).status !== 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
await test('Python -O 不會關閉題組、路徑、內容與動作格式驗證', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-eval-optimized-'));
  try {
    for (const invalid of [
      suite => { suite.cases[0].id = '../../escape'; },
      suite => { suite.notes['../outside.md'] = 'private'; },
      suite => { suite.cases[1].id = suite.cases[0].id; },
      suite => { suite.cases[0].criteria = []; },
      suite => { suite.cases[0].turns = [{ command: '/unknown command' }]; },
      suite => { suite.cases[0].turns = [{ prompt: 42 }]; },
      suite => { suite.cases[0].turns = [{ replaceNote: { path: '../outside.md', text: 'private' } }]; },
    ]) {
      const suite = JSON.parse(readFileSync(resolve('eval/tasks.json'), 'utf8'));
      invalid(suite); const file = join(dir, 'suite.json'); writeFileSync(file, JSON.stringify(suite));
      const result = spawnSync('python3', ['-O', runner, '--validate', '--suite', file], { encoding: 'utf8', timeout: 10000 });
      assert(result.status !== 0); assertIncludes(result.stderr, 'Invalid suite:');
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
await test('RPC 等到 agent_settled，保留 agent_end 後的 continuation 事件', () => {
  const result = protocol([
    { type: 'response', id: '@request', success: true, data: { accepted: true } },
    { type: 'agent_start' }, { type: 'agent_end' }, { type: 'agent_start' },
    { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'final continuation' }], stopReason: 'stop' } },
    { type: 'agent_end' }, { type: 'agent_settled' },
  ]);
  assert(result.ok && result.value.accepted && result.events.at(-1).type === 'agent_settled');
  assert(result.events.some(e => e.message?.content?.[0]?.text === 'final continuation'));
});
await test('RPC 完成需符合本次 ID，不能因其他 response 或先前 settled 提早完成', () => {
  const result = protocol([
    { type: 'agent_settled' }, { type: 'response', id: 'another-request', success: true, data: 'wrong' },
    { type: 'agent_start' }, { type: 'agent_end' }, { type: 'agent_settled' },
    { type: 'response', id: '@request', success: true, data: 'correct' },
  ]);
  assert(result.ok && result.value === 'correct' && result.events.at(-1).id === '1');
});
await test('只有其他 request 的成功回應仍會逾時，錯誤訊息不留空', () => {
  const result = protocol([
    { type: 'response', id: 'another-request', success: true },
    { type: 'agent_start' }, { type: 'agent_end' }, { type: 'agent_settled' }, { sleep: 0.3 },
  ], { timeout: 0.08 });
  assert(!result.ok && result.errorType === 'TimeoutError'); assertIncludes(result.error, 'timed out');
});
await test('Extension 與 mode 命令錯誤不被 RPC prompt success 掩蓋', () => {
  for (const event of [
    { type: 'extension_error', error: 'extension fixture failure' },
    { type: 'message_end', message: { role: 'custom', customType: 'pi-mode-error', content: JSON.stringify({ error: 'mode fixture failure' }) } },
    { type: 'message_start', message: { role: 'custom', customType: 'pi-mode-error', content: [{ type: 'text', text: JSON.stringify({ error: 'mode fixture failure' }) }] } },
  ]) {
    const result = protocol([event, { type: 'response', id: '@request', success: true }], { waitTurn: false });
    assert(!result.ok && result.errorType === 'RuntimeError'); assertIncludes(result.error, 'fixture failure');
  }
});
await test('模型錯誤與中止都會停止案例，避免用失敗答案繼續多輪', () => {
  for (const stopReason of ['error', 'aborted']) {
    const result = protocol([
      { type: 'response', id: '@request', success: true }, { type: 'agent_start' },
      { type: 'message_end', message: { role: 'assistant', stopReason, errorMessage: 'provider fixture failure' } },
      { type: 'agent_end' }, { type: 'agent_settled' },
    ]);
    assert(!result.ok && result.errorType === 'RuntimeError'); assertIncludes(result.error, `Pi model ${stopReason}`);
  }
});
await test('RPC 自動取消權限問題；只執行 command 時不等待模型 turn', () => {
  const result = protocol([
    { type: 'extension_ui_request', id: 'permission', method: 'confirm' }, { readUI: true },
    { type: 'response', id: '@request', success: true, data: 'command-completed' },
  ], { waitTurn: false });
  assert(result.ok && result.value === 'command-completed');
  assert(result.events.some(e => e.type === 'ui_checked' && e.cancelled === true && e.responseType === 'extension_ui_response'));
});
report();
