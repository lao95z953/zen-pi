# Pentest 學習 Agent：使用與限制

另有 [研究與論文模式](research.md)，可用 `/research <問題>` 開始、`/research off` 回一般模式。新對話預設一般模式，`/study` 才進入學習，完整切換規則見 [模式](modes.md)。兩者共用 Wiki，研究紀錄不等於理解評量。

## 選擇目前筆記

- 在 Obsidian 啟用 **Zen Pi Study Bridge**，在 Pi 執行 `/reload`。
- `/study` 進入學習並顯示目前讀取來源；`/study auto` 跟隨 Obsidian。
- 「我現在在讀 NAT&Reverse-Shell 那篇，幫我檢查理解」會指定那篇。
- 「我在讀 SMB 那篇」若匹配多篇，會列候選，不猜。
- `/study 03-概念/SMB&Samba.md` 可精確指定。
- 「切回自動跟隨」恢復自動模式。
- 指定模式在切換 Obsidian 分頁後維持不變，並隨 Pi session 儲存；新 session 預設一般模式，進入學習後預設自動跟隨。

辨識規則只處理明確的句首指定；其他語言表達由模型呼叫 `study_focus`。引述別人說「我在讀…」不應切換。

## 檢索與 context

學習模式每次開始回答前讀取最新快照：目前筆記、最多三篇相關頁（wiki link 作排序加分，仍需符合問題）、最多四筆相關記憶，以及近期使用者回答的定位資訊。新增快照限制為 26000 字元，不是整段對話的 token 上限；傳給模型時只保留最新 study 快照，Pi 的歷史紀錄不刪除。

`study_search` 使用中英文斷詞、少量術語對應和 BM25，搜尋篇名及內容；不是 embedding 語意搜尋。檔案有更新時才重讀正文，長篇挑選相關區段或游標附近。`study_read` 可繼續讀指定行，回傳行號與版本雜湊。生成的 Wiki 不混入原始筆記索引，走獨立的記憶檢索。

Bridge 在編輯停止 250 ms 後發布，另有 10 秒 heartbeat。Pi 不會在每打一個字時呼叫模型，下一輪提問才更新 context，狀態列也在提問或 `/study` 時刷新。

Bridge 在本機 `~/.pi/agent/obsidian/<vault-hash>.json` 存放目前頁面和編輯器文字，檔案權限 0600，不寫入同步的 vault。這些筆記內容在 Pi 問答時會送給你選擇的 LLM provider。Bridge 停用、關閉或超過 45 秒無更新，就不再宣稱知道目前頁面。`workspace.json` 僅顯示上次頁面的提示，不冒充即時資料。

使用 Study 前設定 `PI_STUDY_VAULT=/absolute/path/to/vault`，並在該 vault 啟用 Bridge。

## 掛載 LLM Wiki

LLM Wiki 與原始筆記庫分開。新對話預設使用 `~/.pi/llm-wiki`，原始筆記仍由 `PI_STUDY_VAULT` 決定。研究模式可以只用網路來源，不必先建立 Obsidian vault。

```text
/wiki use ./llm-wiki
/wiki use ~/research/llm-wiki
/wiki use /absolute/path/to/llm-wiki
/wiki default
```

相對路徑以目前 Pi 的工作目錄為準，Web 則以目前 Workspace 為準。指定目錄不存在時會建立。`/wiki default` 回到 `~/.pi/llm-wiki`；可用 `PI_LLM_WIKI=/absolute/path` 覆寫預設位置。

掛載只影響目前對話的記憶與來源快照，不改變原始筆記庫，也不重設指定筆記或 Obsidian 跟隨。Session 保存絕對路徑，重開或 Fork 後不會因 cwd 改變而轉向別處。掛載目錄消失、變成 symlink，或使用的別名被刪除／改路徑時，記憶操作會停止並要求重新選擇，不退回預設位置。切換掛載也會清除先前的已讀引用授權，保存前須重新讀取來源。

常用位置可在 `~/.pi/agent/ronny.json` 登記，修改後不用重新啟動：

```json
{
  "llmWikis": { "research": "~/research/llm-wiki", "project": "/path/to/project/llm-wiki" }
}
```

`/wiki list` 顯示目前位置與別名；`/wiki use research` 掛載對應目錄。`default` 是保留名稱。

舊設定的 `wikis` 仍指向 Obsidian vault，其別名現在明確對應該 vault 的 `07-Agent-Wiki` 子目錄。舊 Session 會保留原先筆記庫與 Wiki 位置；不自動搬移已有內容。`defaultWiki` 只作未設定 `PI_STUDY_VAULT` 時的舊版來源筆記庫相容設定，不再決定新對話的 LLM Wiki。要從舊對話改用新預設位置，執行 `/wiki default`。

## 知識與理解分開保存

目前掛載的 LLM Wiki 目錄直接包含：

- `concepts/`：概念頁，需要已讀來源的版本、行號、原文引文。
- `learning/`：你實際回答的證據、提問情境、模型判斷理由與下一題。
- `sources/`：實際抓取的公開網頁文字快照。
- `.records/`：不可變 JSON 歷史，每次更新新增版本。
- `index.md` 和 `schema.md`：索引與使用規則。

工具中的 `07-Agent-Wiki/` 是指向目前掛載 Wiki 的虛擬前綴，供 `study_read` 讀取來源快照；保存收據提供實際檔案路徑。新紀錄的筆記引用會保存原本來源 vault，避免不同筆記庫的同名檔案混淆。

原始筆記不由記憶工具修改。Wiki 的 Markdown 是生成視圖，重建會覆寫；自己的補充請寫在原始筆記，再請 Agent 更新概念頁。

`study_wiki` 驗證來源版本、行段和引文都曾實際展示給模型，包含長行被截斷的邊界；這不等於自動證明整篇推論正確。`study_observe` 驗證證據是近期真實使用者訊息，不能拿 Agent 自己的答案充數；模型仍可能高估理解程度。因此學習狀態是待複查、部分理解、能解釋、能應用的觀察，不是永久掌握認證。

學習模式會按當前問題檢索概念與同題最近的學習觀察；不同題的未解問題繼續保留。長篇記憶挑選與查詢相關的段落，並附片段位置和截斷標記。保存需要模型呼叫工具；你也可以明確說「把這個概念整理進 wiki」或「記住我這次卡住的地方」，不宣稱背景自動抽取所有對話。

## 網路查證

`study_web_search` 搜尋公開概念詞，`study_web_read` 抓取選定頁面。搜尋摘要不能冒充讀過全文。

目前使用 Bing 公開 RSS，無金鑰但不保證可用性與結果品質。遇到驗證或格式改動會回報失敗，可以提供公開來源 URL。僅抓 HTML／文字，不執行網頁 JavaScript、不登入、不處理 PDF。

URL、DNS 與重新導向都檢查公開位址，不會藉這個工具連內網靶機。單頁上限 2 MiB；保存正文最多 19000 字元，截斷會標示。查詢會送往搜尋服務，請用概念詞，不要提交私人筆記、帳密或靶機祕密。

## 維護

- `/wiki list`：列出 Wiki 別名與目前掛載路徑。
- `/wiki use <路徑或名稱>`：切換目前對話的 LLM Wiki；來源筆記庫不變。
- `/wiki default`：回到預設 LLM Wiki。
- `/wiki` 或 `/wiki check`：來源變更／消失、版本衝突、超過 30 天的學習觀察。
- `/wiki rebuild`：由 JSON 紀錄重建 Markdown 視圖。
- `/wiki forget <id>`：新增撤回紀錄，停止檢索，歷史仍保留；不是隱私資料的徹底刪除。
- 同主題並行版本不靜默合併；檢查後撤回不要的版本，再更新保留的版本。

更多設計取捨與參考來源見 [context-memory.md](context-memory.md)。
