# Context 與 Memory 的設計決定

核對日期：2026-09-11。借用開源專案的設計方式，沒有安裝或嵌入它們的執行框架。

後續新增研究與論文模式，沿用相同紀錄格式並加入 research 類型；arXiv／Crossref、PDF 文字片段與論文比較的現行規格見 [research.md](research.md)。以下「網路」段落描述原有一般網頁工具，不包括新增 PDF 工具。

| 參考 | 採用 | 目前未採用 |
|---|---|---|
| [QMD](https://github.com/tobi/qmd) | 分段定位、BM25、查詢術語擴充、來源定位 | 向量模型、LLM reranking、QMD 服務本身 |
| [Letta Context Repositories](https://www.letta.com/blog/context-repositories/) | 漸進載入、可讀的檔案記憶、版本可追溯 | Letta server、背景記憶 agent、Git 同步 |
| [Karpathy LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) | 原始來源／衍生 wiki 分離、概念連結、來源檢查、可重建索引 | 全量自動匯入既有筆記、未經檢查的事實合併 |

## 為什麼先做本機版本

目前筆記庫規模小，中英文 BM25、少量術語對應及 Markdown 關聯足以形成可測的基線。不下載 embedding/reranker 模型，不需要 GPU 或額外 LLM 呼叫。這不是語意向量搜尋。之後用實際漏掉的查詢評估是否接 QMD，而不是預先增加另一個服務。

## Context

學習模式每輪加入目前筆記、最多三篇關聯頁、最多四筆相關概念／學習觀察、最近使用者訊息的引用定位。新增 context 快照限制 26000 **字元**，不是 token；超過會先減少關聯內容。模型可用 study_read 分頁補讀。舊快照不再送給模型，但 Pi session 的歷史不被刪除。

2026-09-12 加入 [SoL-Pi 整合](sol-pi.md)：成功的大型純文字工具結果在前兩次模型請求保留全文，之後用可回查的 ID 與首尾片段替代。這處理工具結果；上面的 study-context 最新快照策略繼續使用。Wiki／理解紀錄保存後回傳收據，完整紀錄用 study_memory(id) 讀取；自動載入的記憶片段標記截斷狀態。

一般模式不自動讀取 vault 或學習記憶；研究模式只帶入研究所需來源及概念，不帶入理解評量。相關頁需符合當前問題，wiki link 僅作排序加分。引用驗證以套用預算後實際展示的行段為準，舊 context 移除後不再作引用依據。

## Memory

- 原始筆記：既有 vault，使用者繼續編輯。
- 概念：機制、成立前提、反例和連結，每頁有來源版本、行號、原文引文。
- 學習觀察：問題、使用者原話、Pi 訊息 ID、判斷理由和下一個待檢查情境。
- 網頁來源：真正抓取的正文快照、URL、查閱日期；搜尋摘要不自動收成知識。

只有模型完成適當的工具呼叫，才會形成新記憶。提示要求在概念釐清和使用者回答後主動使用工具，但目前沒有額外背景 LLM 回顧程序；無法保證每輪都會自動整理。使用者可直接說「把剛才的概念整理進 wiki」。

理解狀態使用 needs-review、partial、explained、applied，不偽造精確分數。程式驗證原話出處，不能機械判斷那段是否抄錄或是否真的理解；這仍是模型教學品質和後續情境題要驗證的部分。

檢索長紀錄時，以查詢相關段落為中心，回傳起訖位置、標題與截斷資訊。同主題但不同問題的學習觀察分開保留；較新的另一題觀察不會使未解問題消失。

## 版本與同步

每次新增／修訂寫入 07-Agent-Wiki/.records/<uuid>.json；不可變 JSON 是權威紀錄。concepts/、learning/、sources/、index.md 是可重建的 Markdown 視圖。修改生成 Markdown 不會改變 Agent 的權威記憶；用工具更新，或要求停用錯誤紀錄。

更新概念需指定前一版本 ID。並行寫入同一前版會留下兩個分支，讀取時標衝突，不按時間戳靜默覆蓋。可以先用 study_memory 讀兩版、/wiki forget 停用選定一版，再整理更新。這能保留 Syncthing 兩台離線更新的證據，不代表自動解決語意衝突。

原始來源 hash 變更或檔案消失，下一次 context／check 動態顯示 changed／missing。網頁快照不會定時重新抓取；需要查新版本時再抓一次。30 天標記只是提醒重新檢查理解，不是遺忘曲線模型。

## 網路

以 Bing 公開 RSS 搜尋和 Node HTTP(S) 抓取 HTML／文字，不需要新增 API key。公開介面的格式、排名與可用性沒有保證；錯誤／驗證頁會明確報失敗。模型應優先找官方來源，必要時用 site: 限定。正文抽取不執行 JavaScript，不支援 PDF、登入頁或瀏覽器互動。

URL 和每次 redirect 都限制公開位址，DNS 解析後固定連線位址；限制單頁 2 MiB、保存正文最多 19000 字元，截斷會標記。不使用瀏覽器 cookie 或登入資訊。只發公開搜尋詞，不把原始私人筆記整篇傳給搜尋引擎。

## 驗證範圍

測試涵蓋快照、模糊指定、跨 session 記憶、版本衝突、來源變動、回答原話驗證、context 上限、搜尋回應解析。另用真正 Pi 加本機假的 OpenAI-compatible provider 執行 tool loop，確認 Wiki／學習記錄可建立並於新對話取回。

網路搜尋與 Samba 原廠文件抓取另有實際 smoke test。這些驗證不等於真實模型的教學品質測試，也不等於 Obsidian 外掛已在使用者介面啟用。
