# Pi 模式與引用

新對話預設為一般模式。學習和研究都要明確啟用，切換模式不會增加掃描、修改原始筆記或對外操作的授權。

| 模式 | 進入方式 | 自動帶入的內容 |
| --- | --- | --- |
| 一般 `general` | `/mode general` | 不載入 Obsidian 目前頁面或學習記憶 |
| 學習 `study` | `/study` 或 `/mode study` | 目前筆記、與問題相關的段落、學習觀察與待釐清問題 |
| 研究 `research` | `/research` 或 `/mode research` | 與研究問題相關的筆記、概念與研究進度；不帶入理解評量 |

`/study NAT.md` 指定筆記並進入學習模式；`/study auto` 改回跟隨 Obsidian。`/study off` 和 `/research off` 都回一般模式，先前指定的筆記仍保留，重新進入學習時可接著用。

`/research <問題>` 開始研究；`/research resume <topic>` 接續已保存的研究。這兩個指令會呼叫模型。`/mode status`、`/study status`、`/research status` 只查狀態，不呼叫模型。執行中的回覆需先停止或完成，才能用指令切換模式。

一般模式仍可在使用者要求時使用筆記或來源工具。`study_observe` 只允許學習模式，`research_save` 只允許研究模式。明確指定「我在讀某篇」會選取筆記；一般模式下也會進入學習，研究模式下則保留研究模式。

模式按目前的對話分支保存。舊版的研究狀態或明確筆記選擇會保留原有研究／學習意圖；新對話及沒有舊狀態的分支使用一般模式。

## 引用如何核對

Wiki 與研究頁保存前，會核對來源版本、引用行號、原文引文，以及模型實際收到的文字。只看過第 1–20 行，就不能引用第 100 行；補讀後才能保存。長行若只顯示前半段，後半段也不能引用。

目前筆記與關聯來源會先套用輸出預算，再登記已展示範圍。舊的筆記快照被移出 context 時，不再提供引用依據；工具明確讀過的片段則保留到切換對話或分支。來源版本改變後，需要重新讀取。這些檢查確認引文有出處，不能代替「來源是否支持結論」的判斷。

## Web UI 的 RPC 介面

這些指令透過 Pi RPC 的 `prompt` 執行，結果以 `message_end` 事件中的 custom message 回傳。`content` 是 JSON 字串，`details` 帶相同資料，`display` 為 `false`。它們不會觸發模型回覆。

| 指令 | `customType` | JSON 內容 |
| --- | --- | --- |
| `/mode general|study|research`、`/mode status` | `pi-mode-state` | `{mode, question?, topic?}` |
| `/study-notes [關鍵字]` | `pi-note-list` | `{notes: [{path, title}]}`，最多 100 篇 |
| `/study-status`、`/study status` | `pi-study-state` | `{mode, focus, status, current: {path, title} | null}` |
| 模式或筆記命令失敗 | `pi-mode-error` | `{error}` |

`/study <path>` 同時回傳模式和筆記狀態。筆記清單是明確請求，可以在一般模式查詢，但不會自行切換模式；清單不包含筆記正文。Web UI 收到錯誤時應顯示錯誤內容，不能只以 RPC 命令已完成判斷切換成功。
