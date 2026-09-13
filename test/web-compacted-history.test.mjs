import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWebServer } from '../web/server.mjs';
const root = await mkdtemp(join(tmpdir(), 'pi-full-history-')), dataDir = join(root, 'data'), sessionDir = join(dataDir, 'sessions');
await mkdir(sessionDir, { recursive: true });
const sessionId = randomUUID(), file = join(sessionDir, `${sessionId}.jsonl`), stamp = new Date().toISOString();
const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0 } };
const picture = { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRusAAAAASUVORK5CYII=' };
const entries = [{ type: 'session', version: 3, id: sessionId, cwd: root, timestamp: stamp }];
function append(type, body) { const id = randomUUID(); entries.push({ type, id, parentId: entries.at(-1).type === 'session' ? null : entries.at(-1).id, timestamp: stamp, ...body }); return id; }
append('message', { message: { role: 'user', content: [{ type: 'text', text: 'Before compaction' }, picture], timestamp: 1 } });
append('message', { message: { role: 'assistant', content: [{ type: 'text', text: 'Original answer' }, { type: 'toolCall', id: 'old-tool', name: 'bash', arguments: { command: 'printf original' } }], usage, timestamp: 2 } });
append('message', { message: { role: 'toolResult', toolCallId: 'old-tool', toolName: 'bash', content: [{ type: 'text', text: 'original output' }], timestamp: 3 } });
const kept = append('message', { message: { role: 'user', content: 'After compaction', timestamp: 4 } });
append('compaction', { summary: 'Compressed context', firstKeptEntryId: kept, tokensBefore: 50000 });
append('message', { message: { role: 'assistant', content: [{ type: 'text', text: 'Recent answer' }], usage, timestamp: 5 } });
// A sibling branch must not leak into the selected leaf's transcript or usage.
const leaf = entries.at(-1); entries.splice(-1, 0, { type: 'message', id: randomUUID(), parentId: entries[1].id, timestamp: stamp, message: { role: 'assistant', content: 'Other branch', usage, timestamp: 3 } });
assert.equal(entries.at(-1), leaf);
await writeFile(file, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
await writeFile(join(dataDir, 'sessions.json'), JSON.stringify({ version: 3, sessions: [{ id: sessionId, file, title: 'History fixture', cwd: root, createdAt: stamp, updatedAt: stamp }], activeId: sessionId, workspacePaths: [], sessionPreferences: {} }));
const fixture = join(root, 'rpc.mjs');
await writeFile(fixture, `import {readFileSync} from 'node:fs'; import {createInterface} from 'node:readline';
const args=process.argv.slice(2),file=args[args.indexOf('--session')+1];
for await(const line of createInterface({input:process.stdin})){const r=JSON.parse(line);let data;
if(r.type==='get_state')data={sessionId:'fixture',sessionFile:file,model:{provider:'fixture',id:'none'},isStreaming:false};
else if(r.type==='get_messages')throw Error('Readable native history must not request the potentially oversized image context');
else if(r.type==='get_commands')data={commands:['mode','study','study-status','study-notes'].map(name=>({name,source:'extension'}))};
process.stdout.write(JSON.stringify({type:'response',id:r.id,command:r.type,success:true,data})+'\\n');}`);
const hash = async () => createHash('sha256').update(await readFile(file)).digest('hex');
const original = await hash(); let app;
try {
  for (let restart = 0; restart < 2; restart++) {
    app = await createWebServer({ dataDir, workspace: root, sessionRoots: [], piBin: process.execPath, piArgs: [fixture], env: { ...process.env, HOME: root } });
    const state = app.snapshot();
    assert.equal(state.error, '');
    assert.deepEqual(state.messages.map(m => m.text), ['Before compaction', 'Original answer', 'After compaction', 'Recent answer']);
    assert.equal(state.messages[0].images[0].id, createHash('sha256').update(Buffer.from(picture.data, 'base64')).digest('hex'));
    assert.ok(!JSON.stringify(state).includes(picture.data), 'Native image history is projected into small references');
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const image = await fetch(`http://127.0.0.1:${app.server.address().port}/api/images/${state.messages[0].images[0].id}`);
    assert.equal(image.status, 200); assert.deepEqual(Buffer.from(await image.arrayBuffer()), Buffer.from(picture.data, 'base64'));
    assert.equal(state.transcript.usage.totals.totalTokens, 30, 'All responses on the current branch contribute; sibling usage does not');
    assert.match(state.transcript.entries.find(e => e.kind === 'tool').input, /printf original/);
    assert.equal(state.transcript.entries.find(e => e.kind === 'tool').output, 'original output');
    assert.equal(await hash(), original, 'Full-history projection never rewrites the native JSONL');
    await app.close(); app = null;
    await rm(join(dataDir, 'images'), { recursive: true, force: true });
  }
  console.log('Pre-compaction messages/tools/usage survive reopening; sibling branches remain excluded and JSONL is untouched');
} finally { await app?.close(); await rm(root, { recursive: true, force: true }); }
