export const WEB_COMMANDS = [
  { name: 'model', description: '選擇目前對話使用的模型', source: 'web', usage: '/model [provider/model 或 model ID]' },
  { name: 'help', description: '查看 Web 可用的指令', source: 'web' },
  { name: 'new', description: '在目前 Workspace 開始新對話', source: 'web' },
  { name: 'reload', description: '重新載入目前 Web 對話的 Pi 擴充套件與設定', source: 'web' },
  { name: 'name', description: '設定目前對話名稱', source: 'web', usage: '/name <新名稱>', argumentHint: '接著輸入新名稱' },
  { name: 'session', description: '查看目前對話資訊', source: 'web' },
  { name: 'thinking', description: '選擇目前模型支援的推理程度', source: 'web', usage: '/thinking [程度]' },
  { name: 'compact', description: '設定摘要重點並確認整理上下文', source: 'web', usage: '/compact [摘要重點]' },
  { name: 'fork', description: '選擇舊訊息，從那裡建立分支對話', source: 'web' },
  { name: 'clone', description: '複製目前分支，建立另一個對話', source: 'web' },
  { name: 'export', description: '下載目前對話的 HTML 檔案', source: 'web' },
  { name: 'copy', description: '複製最後一則回覆', source: 'web' },
  { name: 'agents', description: '查看子 Agent 的工作與狀態', source: 'web' },
  { name: 'side', description: '開啟 Side Chat；問題會填入草稿，需再送出', source: 'web', usage: '/side [問題]' },
];

export const TERMINAL_COMMANDS = new Set(['settings', 'tree', 'scoped-models', 'import', 'share', 'changelog', 'hotkeys', 'trust', 'login', 'logout', 'resume', 'quit']);
const INTERNAL_COMMANDS = new Set(['study-status', 'study-notes']);
const COMMAND_USAGE = {
  browser: { usage: '/browser <setup|tabs|status|stop|分頁 ID 或網址 任務>', suggestions: [
    { value: '/browser setup', label: '連接 Zen Browser' },
    { value: '/browser tabs', label: '列出可操作的分頁' },
    { value: '/browser status', label: '查看瀏覽器任務' },
    { value: '/browser stop', label: '停止瀏覽器任務' },
  ] },
  mode: { usage: '/mode <general|study|research|status>', suggestions: [
    { value: '/mode general', label: '一般模式', description: '自由討論，不自動載入筆記' },
    { value: '/mode study', label: '學習模式', description: '從筆記釐清概念與理解' },
    { value: '/mode research', label: '研究模式', description: '查閱來源與推進研究問題' },
    { value: '/mode status', label: '查看目前模式' },
  ] },
  study: { usage: '/study [auto|status|off|筆記篇名]', suggestions: [
    { value: '/study auto', label: '自動選擇筆記', description: '跟隨 Obsidian 的筆記線索' },
    { value: '/study status', label: '查看目前筆記與學習狀態' },
    { value: '/study off', label: '離開學習模式', description: '回到一般模式' },
  ] },
  research: { usage: '/research [問題|resume <topic>|status|off]', suggestions: [
    { value: '/research resume', label: '接續研究（填入 topic）', argumentHint: '接著輸入研究 topic' },
    { value: '/research status', label: '查看目前研究狀態' },
    { value: '/research off', label: '離開研究模式', description: '回到一般模式' },
  ] },
  wiki: { usage: '/wiki [list|use <路徑或名稱>|default|check|rebuild|forget <id>]', suggestions: [
    { value: '/wiki list', label: '查看目前 Wiki 與掛載別名' },
    { value: '/wiki use ./llm-wiki', label: '掛載目前 Workspace 的 llm-wiki', description: '只切換 Wiki，來源筆記庫不變' },
    { value: '/wiki default', label: '回到預設 LLM Wiki' },
    { value: '/wiki check', label: '檢查知識紀錄的來源' },
    { value: '/wiki rebuild', label: '重建知識紀錄的 Markdown' },
    { value: '/wiki forget', label: '停用紀錄（填入 ID）', description: '停止檢索該筆紀錄，保留歷史', argumentHint: '接著輸入紀錄 ID' },
  ] },
};
const DEFAULT_COMMANDS = [
  { name: 'mode', description: '切換一般、學習或研究模式', source: 'extension' },
  { name: 'study', description: '進入學習模式或指定筆記', source: 'extension' },
  { name: 'research', description: '開始研究問題', source: 'extension' },
];

export function safeCommands(commands) {
  return (Array.isArray(commands) ? commands : []).filter(command =>
    typeof command?.name === 'string' && command.name.length <= 200 && /^[^\s/]+$/.test(command.name) && !INTERNAL_COMMANDS.has(command.name))
    .map(command => ({ name: command.name, description: typeof command.description === 'string' ? command.description.slice(0, 300) : '',
      source: ['extension', 'prompt', 'skill'].includes(command.source) ? command.source : 'extension', ...safeCommandUsage(command) }));
}

function safeCommandUsage(command) {
  const metadata = Object.hasOwn(COMMAND_USAGE, command.name) ? COMMAND_USAGE[command.name] : command, safe = {};
  if (typeof metadata.usage === 'string' && !/[\r\n\0]/.test(metadata.usage)) safe.usage = metadata.usage.slice(0, 500);
  if (Array.isArray(metadata.suggestions)) {
    const values = new Set();
    safe.suggestions = metadata.suggestions.filter(suggestion => {
      if (typeof suggestion?.value !== 'string' || suggestion.value.length > 500 || /[\r\n\0]/.test(suggestion.value)) return false;
      const parsed = parseSlash(suggestion.value);
      if (!parsed || parsed.name !== command.name || values.has(suggestion.value)) return false;
      values.add(suggestion.value); return true;
    }).slice(0, 12).map(suggestion => ({ value: suggestion.value,
      label: typeof suggestion.label === 'string' ? suggestion.label.slice(0, 200) : suggestion.value,
      ...(typeof suggestion.description === 'string' ? { description: suggestion.description.slice(0, 300) } : {}),
      ...(typeof suggestion.argumentHint === 'string' && suggestion.argumentHint.length <= 200 && !/[\u0000-\u001f\u007f\u2028\u2029]/.test(suggestion.argumentHint)
        ? { argumentHint: suggestion.argumentHint } : {}) }));
  }
  return safe;
}

export function commandCatalog(commands) {
  const catalog = new Map(WEB_COMMANDS.map(command => [command.name, command]));
  for (const command of safeCommands(commands ?? DEFAULT_COMMANDS)) if (!catalog.has(command.name)) catalog.set(command.name, command);
  return [...catalog.values()];
}

export function parseSlash(message) {
  if (!message.startsWith('/')) return null;
  const match = /^\/([^\s]*)(?:\s+([\s\S]*))?$/.exec(message);
  return { name: match?.[1] || 'help', args: match?.[2]?.trim() || '' };
}

export function safeModels(models) {
  return (Array.isArray(models) ? models : []).filter(model => typeof model?.provider === 'string' && model.provider.length <= 200 &&
    typeof model.id === 'string' && model.id.length <= 500).map(model => ({ provider: model.provider, id: model.id,
      name: typeof model.name === 'string' ? model.name.slice(0, 300) : model.id, reasoning: model.reasoning === true }));
}
