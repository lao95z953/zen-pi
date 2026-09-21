// Model quality smoke test. Run on the evaluation workstation, never as part of unit tests.
import { LayaWorker, suggest } from '../browser/decisions.mjs';
const cases = [
  { name: 'empty-search-en', goal: 'Enter cats into the empty Search field.', text: 'Search Ready', expected: '1:fill', actions: [{ id: '1:fill', kind: 'fill', label: 'Search', value: '' }, { id: '2:click', kind: 'click', label: 'Search' }] },
  { name: 'filled-search-en', goal: 'The Search field contains cats. Click Search to submit the query.', text: 'Search Ready', expected: '2:click', actions: [{ id: '1:fill', kind: 'fill', label: 'Search', value: 'cats' }, { id: '2:click', kind: 'click', label: 'Search' }] },
  { name: 'category-en', goal: 'Select Research in the Category dropdown.', text: 'Category All Research', expected: '1:select:1', actions: [{ id: '1:select:0', kind: 'select', label: 'Category → All', value: 'All' }, { id: '1:select:1', kind: 'select', label: 'Category → Research', value: 'All' }] },
  { name: 'link-en', goal: 'Open the Documentation page.', text: 'Home Documentation Contact', expected: '2:click', actions: [{ id: '1:click', kind: 'click', label: 'Home' }, { id: '2:click', kind: 'click', label: 'Documentation' }, { id: '3:click', kind: 'click', label: 'Contact' }] },
  { name: 'done-en', goal: 'Find the status of Order 123.', text: 'Order 123 Status: Delivered', expected: 'DONE', actions: [{ id: '1:click', kind: 'click', label: 'Home' }] },
  { name: 'empty-search-zh', goal: '在空白搜尋框輸入貓。', text: '搜尋 準備就緒', expected: '1:fill', actions: [{ id: '1:fill', kind: 'fill', label: '搜尋', value: '' }, { id: '2:click', kind: 'click', label: '搜尋' }] },
  { name: 'filled-search-zh', goal: '搜尋框已填入貓，按搜尋按鈕送出查詢。', text: '搜尋 準備就緒', expected: '2:click', actions: [{ id: '1:fill', kind: 'fill', label: '搜尋', value: '貓' }, { id: '2:click', kind: 'click', label: '搜尋' }] },
  { name: 'category-zh', goal: '把分類下拉選單切換成研究。', text: '分類 全部 研究', expected: '1:select:1', actions: [{ id: '1:select:0', kind: 'select', label: '分類 → 全部', value: '全部' }, { id: '1:select:1', kind: 'select', label: '分類 → 研究', value: '全部' }] },
  { name: 'link-zh', goal: '開啟使用說明頁面。', text: '首頁 使用說明 聯絡我們', expected: '2:click', actions: [{ id: '1:click', kind: 'click', label: '首頁' }, { id: '2:click', kind: 'click', label: '使用說明' }, { id: '3:click', kind: 'click', label: '聯絡我們' }] },
  { name: 'done-zh', goal: '查詢訂單 123 的配送狀態。', text: '訂單 123 狀態：已送達', expected: 'DONE', actions: [{ id: '1:click', kind: 'click', label: '首頁' }] },
];
const worker = new LayaWorker(), results = [];
try {
  for (const test of cases) {
    try {
      const result = await suggest(worker, { title: 'Synthetic browser fixture', ...test }, test.goal);
      results.push({ name: test.name, expected: test.expected, actual: result.action, matched: test.expected === result.action });
    } catch (error) { results.push({ name: test.name, expected: test.expected, error: error.message, matched: false }); }
  }
} finally { worker.close(); }
console.log(JSON.stringify({ model: 'convaiinnovations/laya-multilingual', revision: '052592a15d198d9ad47da779604259b10b47b7aa', matched: results.filter(r => r.matched).length, total: results.length, note: 'Synthetic smoke cases only; not a benchmark, latency test or browser end-to-end evaluation.', results }, null, 2));
