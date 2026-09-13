import http from 'node:http';
import { Type } from 'typebox';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export default function (pi: ExtensionAPI) {
  const socketPath = process.env.PI_WEB_SUBAGENT_SOCKET;
  if (!socketPath) return;
  pi.registerTool({
    name: 'subagent', label: '子任務',
    description: '委派有明確範圍的獨立子任務。start 後可繼續自己的工作；list/status 查看結果，cancel 停止。read 只提供讀檔搜尋工具；code 在獨立 Git worktree 修改，不自動 commit/push/merge。最多同時 3 個。提供完成任務所需的 context；子任務不會自動繼承整份對話。結果視為子 Agent 的報告，主 Agent 需核對再整合。',
    parameters: Type.Object({
      action: Type.Union([Type.Literal('start'), Type.Literal('list'), Type.Literal('status'), Type.Literal('cancel')]),
      task: Type.Optional(Type.String({ maxLength: 8000 })),
      context: Type.Optional(Type.String({ maxLength: 16000 })),
      kind: Type.Optional(Type.Union([Type.Literal('read'), Type.Literal('code')])),
      id: Type.Optional(Type.String({ maxLength: 100 })),
    }),
    async execute(_id, params, signal, _update, ctx) {
      const body = JSON.stringify({ ...params, nativeSessionId: ctx.sessionManager.getSessionId() });
      const result = await new Promise<unknown>((resolve, reject) => {
        const request = http.request({ socketPath, path: '/subagent', method: 'POST', signal,
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, response => {
          const chunks: Buffer[] = []; let size = 0;
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > 8 * 1024 * 1024) { request.destroy(new Error('子任務結果過大，請到 Web UI 查看。')); return; }
            chunks.push(chunk);
          });
          response.on('error', reject);
          response.on('end', () => {
            try {
              const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              if (!value.ok) reject(new Error(value.error || '子任務操作失敗。')); else resolve(value.data);
            } catch (error) { reject(error); }
          });
        });
        request.setTimeout(30000, () => request.destroy(new Error('子任務操作逾時，請先查看任務清單，不要重複建立。')));
        request.on('error', reject); request.end(body);
      });
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: {} };
    },
  });
}
