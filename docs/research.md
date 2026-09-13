# 研究與論文模式

在 Pi 執行 `/reload` 後：

```text
/research 我的 Agent 記憶設計有哪些相關研究？哪些機制值得借用？
/research status
/research off
```

`/research <問題>` 會切換模式並開始一輪研究；單獨 `/research` 只切換，等你提出問題。也可說「切換到研究模式」「切回學習模式」。`/study <篇名>` 指定來源並進入學習；之後可再切研究。`/research off` 回一般模式。

## 研究流程

- 想法：拆成可研究問題與假說，先查近 12 個月候選，再找經典與最接近的方法。不是只按年份排序就稱為前沿，不保證搜尋完整或證明首創。
- 文獻：arXiv 預印本與 Crossref metadata 可按日期、相關性查找；按 ID 核對作者、標題、版本與 DOI，產生基本 BibTeX。其他領域或會議可用原有網路查證補充。
- 閱讀：metadata／摘要和 PDF／HTML 正文片段分開標記。來源不足的資料集、數值或實驗設定寫「未取得」，不補猜。
- 比較：研究問題、方法、資料集與評估、限制、與我們工作的關係。不同 split／預算／協議的數字不能直接拿來排名。
- 借用：來源設計 → 如何改造 → 前提與風險 → baseline、ablation 和控制變因的驗證方案。新穎性是待驗證差異，不是搜尋不到就認定首創。
- 草稿：先讀你指定的 Markdown 稿件或實驗筆記，找相近論文，再保存有引用的相關工作、方法或實驗報告草稿；原始稿件預設不改。

範例：

```text
/study 研究草稿.md
/research 找和這篇草稿最接近的論文，對照研究問題、方法和評估，再指出我們的貢獻還缺什麼證據
```

## LLM Wiki 記憶

沿用 `07-Agent-Wiki/`，增加 `research/<topic>.md`；來源、論文摘要和 PDF 文字快照仍在 `sources/`。概念在 `concepts/`，理解觀察在 `learning/`，彼此不混同。研究模式禁止理解評量工具。

研究頁由 `research_save` 保存：問題、範圍、來源陳述／推論／假說、論文對照、設計借用、實驗計畫／紀錄、草稿段落、未知與下一步。`draft` 是進度；`synthesis` 需有已讀來源支持的發現，但不是事實認證。生成正文合計上限 20000 字元，長研究需拆 topic。

每次修訂新增 JSON 歷史，需指定舊版本 ID。`/wiki check` 檢查來源變動與版本衝突，`/wiki rebuild` 重建視圖，`/wiki forget <id>` 停止檢索但保留歷史。不要直接修改生成的 Markdown 期待它改變 Agent 記憶。

模式、問題及選定研究隨 Session 的當前分支恢復；全新 Session 預設一般模式。要跨 Session 繼續，使用：

```text
/research resume <topic>
```

topic 是保存時回傳的英文代號，不是 Session ID。接續時會讀研究進度，不需要保留整段聊天。切換 Session 或回到歷史節點不撤銷 Wiki 寫入。

## 證據與限制

- 每個比較或設計借用需有來源編號，引文與來源版本都要吻合。程式驗證出處，不會自動證明推論成立。
- 實驗 `planned` 不能填已完成結果；`observed` 需原始實驗筆記的引用。程式不能判斷筆記中的數據是否真實，模型仍須核對數字、條件與引用。
- 學術工具：`research_papers` 搜尋、`research_paper` 保存摘要／書目、`research_pdf_read` 抽取公開 PDF。原有 `study_search/read/memory` 和網頁工具共用。
- PDF 需要本機 Poppler（pdfinfo、pdftotext）。每次 1–10 頁，12 MiB 下載上限，保存最多 18000 字元；截斷時減少頁數重讀。文字抽取不是視覺閱讀，不支援 OCR，公式、圖表與雙欄可能失真。不繞付費牆或登入。
- PDF 依 URL 和 SHA-256 重用下載，並行讀不同頁不重複下載；快取上限 128 MiB、128 筆 URL 索引。`refresh=true` 明確重新抓取，cacheHit 不表示已檢查遠端最新版。相同內容與頁段重用來源紀錄；新內容留下新快照，快取清理不刪除來源歷史。
- 論文搜尋每次最多六筆；arXiv 呼叫間隔至少約三秒。API 可能限流，Crossref 也可能沒有摘要；失敗會明說。日期和 metadata 可能有誤，投稿前核對原文；BibTeX 使用保守的 misc 類型，不假造期刊欄位。
- 搜尋詞會傳到外部服務；不要傳未公開草稿、私密實驗內容或憑證。筆記片段及來源會送到你選的模型 provider。
- 研究能力取決於模型與實際工具使用；沒有背景自動研究或額外多 Agent，也不會自動執行實驗。保存需模型完成工具呼叫。

接口依據：[arXiv API](https://github.com/arXiv/arxiv-docs/blob/develop/source/help/api/user-manual.md)、[Crossref REST API](https://www.crossref.org/documentation/retrieve-metadata/rest-api/)。Wiki 延續 [既有設計](context-memory.md)，未另裝記憶框架。
