# Zen Pi

Zen Pi 是 [Pi](https://github.com/earendil-works/pi) 的 Agent extension 與本機 Web UI。它把一般對話、Obsidian 筆記學習和來源查證研究分成明確的模式，並依 Workspace 管理 Pi Session。Web UI 提供 Side Chat、Fork、Sub Agent、Transcript 和 Token 用量；可在電腦使用，也可透過 Tailscale Serve 從手機連線。

## 開始使用

需要 Node.js 22、npm、[Pi](https://github.com/earendil-works/pi) 0.85.1，以及你自己的模型登入。Study 模式另需 Obsidian vault；PDF 來源讀取需要 Poppler 的 `pdftotext`。Zen Pi 不包含模型帳號或筆記內容。

```bash
git clone https://github.com/lao95z953/zen-pi.git
cd zen-pi
npm ci --ignore-scripts --legacy-peer-deps
pi install .
```

使用 Study 時，先設定 `PI_STUDY_VAULT` 為 vault 的絕對路徑，再安裝並啟用 Obsidian 外掛：

```bash
export PI_STUDY_VAULT=/path/to/your/vault
node scripts/install-study-bridge.mjs "$PI_STUDY_VAULT"
pi
```

在 Pi 執行 `/study` 進入學習模式，`/research <問題>` 開始研究；`/mode general` 回一般模式。切換規則見 [模式](docs/modes.md)，學習來源與保存規則見 [Study](docs/study.md)、[Research](docs/research.md)。

啟動本機 Web UI：

```bash
npm run web
```

開啟 <http://127.0.0.1:4318>。Web server 只監聽 loopback；手機存取可依 [Web UI 文件](docs/web.md)設定 Tailscale Serve。Web UI 可以讀取本機 Pi Session，並能以 Pi 的權限操作 Workspace；不要將此服務直接暴露到公網。

## 功能與限制

- Workspace 依對話工作目錄分組，列出 Web 與本機 Pi Session。Side Chat 和 Fork 顯示在父 Session 底下，可重新命名、移到回收清單與還原。
- 輸入框可貼上圖片，或從電腦、手機選檔；提供縮圖、放大與移除。支援 PNG、JPEG、WebP、GIF，每則最多 4 張、每張 5 MiB、合計 8 MiB。圖片可隨生成中的補充訊息送出，未交付的附件可恢復至原 Session 草稿。模型需支援圖片輸入。
- Study 根據目前筆記與已展示的來源整理 Wiki 和理解紀錄；Research 保存查證進度。來源引用記錄版本與片段，模型的推論仍需檢查。
- LLM Wiki 預設位於 `~/.pi/llm-wiki`。用 `/wiki use ./llm-wiki` 依目前 Workspace 掛載其他位置，`/wiki default` 回預設；來源筆記庫保持不變。也可在 `ronny.json` 的 `llmWikis` 登記別名。
- 模型提供思考文字時，主對話會在生成中即時顯示可收合的「思考過程」，並在重新開啟 Session 後保留。模型未提供可顯示的文字時，介面不會根據推理 Token 猜測內容。
- Web UI 會把對話中的 `mermaid` 程式碼區塊顯示成圖表，並提供縮放與原始碼複製；圖表語法錯誤時仍可閱讀原始碼。
- Web UI 會把對話中的 LaTeX 算式排版成 MathML，支援 `$$…$$`、`\[…\]` 與 `\(…\)`；語法有誤時保留原始 LaTeX 和 KaTeX 的錯誤說明。
- Transcript 在主視窗顯示訊息、工具輸入輸出與錯誤。Token 數字以 Pi／模型回報為準；分支歷史累計包含重複讀取的快取，不等於上下文占用或帳單。
- Sub Agent 在獨立 Pi Session 執行；程式任務使用 Git worktree。`read` 工具限制不是作業系統沙箱，結果需由主 Agent 或使用者檢查。詳見 [Sub Agent](docs/subagents.md)。
- 實驗版 [Zen Browser Bridge](docs/browser.md) 可用 `/browser` 明確啟動指定分頁操作；選用本機 Laya 提供下一步建議，再由 Pi 核對執行。
- 可選用 [NVIDIA SoL-Pi](https://github.com/NVlabs/SoL-Pi) 的 Action Fusion 與 ObservationPack；Zen Pi 不內含 SoL-Pi。整合方式見 [SoL-Pi](docs/sol-pi.md)。

## 開發

```bash
npm run check
npm test
python3 eval/run.py --validate
```

測試使用臨時 vault 與本機假 provider，不需要付費模型。實際模型品質需另外評估，fixture 通過不代表研究或教學答案正確。開發流程見 [development.md](docs/development.md)。

本專案採用 [MIT License](LICENSE)。
