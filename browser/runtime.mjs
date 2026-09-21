import { ensureBridge, request } from './client.mjs';
import { LayaWorker, suggest } from './decisions.mjs';

export class BrowserRuntime {
  constructor({ connect = ensureBridge, call = request, worker = new LayaWorker() } = {}) {
    this.connect = connect; this.call = call; this.worker = worker; this.lease = null; this.page = null; this.history = []; this.busy = false; this.starting = false; this.generation = 0;
  }
  async setup() { this.config = await this.connect(); return { path: this.config.path, ...await this.call(this.config, { op: 'status' }) }; }
  async tabs() { await this.setup(); return this.call(this.config, { op: 'tabs' }); }
  async begin(target, goal) {
    if (this.lease) throw new Error('請先 /browser stop 結束目前任務。');
    if (this.busy || this.starting) throw new Error('請等待上一個瀏覽器步驟結束。');
    if (!goal?.trim() || goal.length > 2000) throw new Error('請提供最多 2000 字的任務。');
    this.starting = true; const generation = this.generation;
    try {
      await this.setup();
      if (generation !== this.generation) throw new Error('任務已停止。');
      const result = await this.call(this.config, { op: 'begin', ...target });
      if (generation !== this.generation) {
        await this.call(this.config, { op: 'stop', lease: result.lease }).catch(() => {});
        throw new Error('任務已停止。');
      }
      this.lease = result.lease; this.page = result.page; this.tabId = result.page.tabId; this.goal = goal; this.history = []; this.steps = 0;
      return this.page;
    } finally { this.starting = false; }
  }
  status() { return { active: !!this.lease, goal: this.lease ? this.goal : null, tabId: this.lease ? this.tabId : null, steps: this.steps || 0 }; }
  async stop() {
    const lease = this.lease; this.generation++; this.lease = null; this.page = null; this.worker.close();
    if (lease) { try { await this.call(this.config, { op: 'stop', lease }); } catch { /* already stopped/disconnected */ } }
    return { stopped: true };
  }
  async run(params, signal) {
    if (!this.lease) throw new Error('請先由使用者執行 /browser 啟動指定任務。');
    if (this.busy) throw new Error('請等待目前的瀏覽器步驟完成。');
    this.busy = true;
    const lease = this.lease;
    const call = async body => {
      if (signal?.aborted || this.lease !== lease) throw new Error('任務已停止。');
      try {
        const result = await this.call(this.config, { ...body, lease }, signal);
        if (this.lease !== lease) throw new Error('任務已停止。');
        return result;
      } catch (error) { await this.stop(); throw error; }
    };
    try {
      if (params.op === 'observe') { this.page = await call({ op: 'observe' }); return this.page; }
      if (params.op === 'finish') {
        if (!['completed', 'blocked'].includes(params.outcome)) throw new Error('請指定 completed 或 blocked。');
        if (params.outcome === 'completed') {
          const page = await call({ op: 'observe' });
          if (!params.verify?.text && !params.verify?.url) throw new Error('完成前請提供要核對的頁面文字或完整 URL。');
          if (params.verify.text && !page.text.includes(params.verify.text) || params.verify.url && page.url !== params.verify.url) throw new Error('完成條件未符合；任務仍啟用。');
          await this.stop();
          return { outcome: 'completed', checked: params.verify, note: '只確認列出的條件；Pi 仍需核對是否涵蓋原始任務。' };
        }
        await this.stop(); return { outcome: 'blocked' };
      }
      if (!['step', 'act'].includes(params.op)) throw new Error('Unknown browser operation');
      if (this.steps >= 30) { await this.stop(); throw new Error('已達單次任務 30 步上限。'); }
      let decision, action;
      if (params.op === 'step') {
        this.page = await call({ op: 'observe' });
        decision = await suggest(this.worker, this.page, params.goal || this.goal, this.history, signal);
        if (signal?.aborted || this.lease !== lease) throw new Error('任務已停止。');
        action = decision.action;
        if (['DONE', 'BLOCKED'].includes(action)) return { decision, requiresVerification: true, page: this.page };
        if (action === 'WAIT') { this.steps++; return { decision, page: this.page, note: '沒有執行操作，請稍後重新觀察；不要連續空轉。' }; }
        const selected = this.page.actions.find(a => a.id === action);
        if (selected?.kind === 'fill') return { decision, needsText: true, field: selected, snapshot: this.page.snapshot,
          note: '請用 browser act 提供此 action 與確切文字；不另呼叫雲端文字模型。' };
        return { decision, proposal: selected || { id: action }, snapshot: this.page.snapshot,
          note: '尚未執行。Pi 需核對此選項符合使用者任務，再用 browser act 執行；信心值不能取代核對。' };
      } else {
        if (!this.page || params.snapshot !== this.page.snapshot) throw new Error('請使用最新觀察的 snapshot。');
        action = params.action;
      }
      if (!['SCROLL_UP', 'SCROLL_DOWN'].includes(action) && !this.page.actions.some(a => a.id === action)) throw new Error('動作不是最新觀察中的選項。');
      if (signal?.aborted || this.lease !== lease) throw new Error('任務已停止。');
      const selected = this.page.actions.find(a => a.id === action);
      const label = selected ? `${selected.kind} ${selected.label}` : action;
      const result = await call({ op: 'act', action, snapshot: this.page.snapshot, text: params.text });
      this.steps++; this.history.push(label); this.page = null;
      return { ...result, decision, next: '重新 observe，確認操作後的實際狀態。' };
    } catch (error) {
      if (signal?.aborted) await this.stop();
      throw error;
    } finally { this.busy = false; }
  }
}
