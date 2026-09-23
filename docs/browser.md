# Zen Browser Bridge（實驗版）

在 Pi 輸入 `/browser <分頁 ID 或網址> <任務>`，讓 Pi 操作指定的 Zen Browser 分頁。支援讀取目前可見的文字與表單、填字、點擊、選擇下拉選項和捲動。瀏覽器工具平時停用；完成、停止或切換 Session 後會再次停用。

這版已在 headless Firefox 和 Zen Flatpak 的臨時 profile 驗證連線及 DOM 操作。尚未驗證一般網站的任務成功率，也不宣稱有 Ultrafast 的速度。Laya 目前只提供建議，Pi 核對後才執行。

## 第一次連接

先安裝這個 Pi package，再重新開啟 Pi；已開啟的終端 Pi 可用 `/reload`。Web UI 的 Pi process 需重新載入 package，通常重啟 Web service 後生效。

1. 在 Pi 執行 `/browser setup`。這會啟動 `127.0.0.1:4319` 的本機 Bridge，產生 `~/.pi/browser/connection.json`，並打包 `~/.pi/browser/zen-pi-browser-bridge.xpi`。打包需要 Python 3。
2. 在 Zen 開啟 `about:debugging#/runtime/this-firefox`，按「載入暫存附加元件」，選擇剛產生的 `.xpi`。
3. 開啟 **Zen Pi Browser Bridge** 的擴充套件選項，選擇 `connection.json`。配對檔含控制 Bridge 的憑證，不要貼進對話或分享。
4. 回 Pi 執行 `/browser tabs`，確認分頁清單。

指令輸出會顯示在 Web 對話中。Pi 在第一則模型回覆前可能尚未寫入對話檔；此時重啟 Web service 後，需重新執行指令查看設定說明或分頁清單。

這是暫存附加元件，重開 Zen 後需要重新載入；配對遺失時再選一次設定檔。Flatpak 版透過網路權限連接 loopback，不需要 Native Messaging host，也不需要修改 Zen 的個人 profile 或簽章設定。

附加元件為操作使用者指定的任意網站，會要求 HTTP(S) 網頁及分頁權限。它只在 Bridge 收到任務時列分頁或注入 content script，不會定時掃描頁面。配對後的連線檢查不包含頁面內容。

## 使用

```text
/browser tabs
/browser 12 在搜尋框輸入 ModernBERT，搜尋後整理前三個結果
/browser https://example.org 查閱這個網頁的介紹
/browser status
/browser stop
```

ID 操作既有分頁；網址會開啟背景分頁。一個 Bridge 同時只接受一個 Session 的任務。閒置 5 分鐘後任務到期；單次任務最多執行 30 步。`stop` 會取消後續操作，但已送出的點擊可能已完成。Web 回覆進行中請按輸入框旁的停止按鈕，它會同時停止 Pi 和瀏覽器任務；回覆結束後可用 `/browser stop`。

Pi 可使用 `browser` 工具的以下操作：

| 操作 | 行為 |
| --- | --- |
| `observe` | 讀取指定分頁，取得一次性的 `snapshot` 與可用 action ID。 |
| `step` | 讓 Laya 建議下一步；不會點擊或填字。可用 `goal` 提供最多 400 字的單步目標。 |
| `act` | 由 Pi 核對後，指定最新的 `snapshot`、action ID 和必要的 `text` 執行一次。 |
| `finish` | `completed` 必須核對指定文字或完整 URL；`blocked` 則停止。文字吻合不代表整個任務必然完成，Pi 仍需核對目標。 |

Laya 選錯或未安裝時，Pi 可用 `observe/act` 接手，並說明接手情況。瀏覽器工具不提供任意 JavaScript、shell 或模型自行指定的 CSS selector。

## Laya 安裝與目前結果

在 repository 根目錄執行：

```bash
npm run browser:model
```

需要 `uv`；安裝會建立 `~/.pi/browser/venv`，下載 Python 3.12、固定版本的 CPU PyTorch／Laya 及模型。模型存放在 Hugging Face 的本機快取。第一次 `step` 載入模型較慢；後續沿用同一個 Python process，停止任務時釋放。正常推論使用離線快取，不呼叫 Jev API，也不自動改用其他雲端模型。

固定版本：`laya==0.3.4`、`torch==2.8.0`；完整依賴見 `browser/laya/uv.lock`。模型為 [Laya Multilingual](https://huggingface.co/convaiinnovations/laya-multilingual/tree/052592a15d198d9ad47da779604259b10b47b7aa)，revision `052592a15d198d9ad47da779604259b10b47b7aa`。上游 model card 標示 Apache-2.0。

2026-09-21 在 Workstation，以 CPU 執行 `eval/browser-laya.mjs` 的 10 個合成案例：英文選對 2/5，繁體中文選對 1/5，合計 3/10。填字、選單和連結案例常被誤判成已完成；最初單一搜尋案例也曾出現高信心的錯誤完成判斷。這些結果只適用於目前的觀察格式、提示與候選分組，不能推論其他 checkpoint 或任務的表現。

搜尋流程的本機微調資料與重現步驟見 [Laya 搜尋決策實驗](../eval/laya-search.md)。如需試用已驗證的本機 checkpoint，設定 `PI_BROWSER_LAYA_MODEL_DIR` 為含 `model.safetensors`、`rl_agent_config.json`、`encoder/`、`tokenizer/` 的完整目錄。未設定時仍使用上述固定 revision 的 Laya Multilingual。`PI_BROWSER_LAYA_DEVICE` 預設 `cpu`，Workstation 評估時可設 `cuda`。這些選項只影響 Laya 的建議，不會讓建議自動執行。

若 checkpoint 留在 Workstation，可讓 Bridge 透過 SSH 啟動那台機器上的 Laya worker。Pi process 需設定 `PI_BROWSER_LAYA_SSH_HOST`（已可免互動登入的 SSH 別名或主機）、`PI_BROWSER_LAYA_SSH_ROOT`（遠端含 `browser/laya/worker.py` 和 `.venv/bin/python` 的絕對目錄）、`PI_BROWSER_LAYA_MODEL_DIR`（遠端 checkpoint 的絕對目錄）與 `PI_BROWSER_LAYA_DEVICE=cuda`。傳往 Workstation 的內容是目前頁面的決策狀態與候選動作；SSH 斷線時 `step` 會失敗，Pi 仍可用 `observe/act`。使用 Web service 時，這些環境變數可寫在 `~/.config/zen-pi-web/environment`，再重啟服務生效。不要把主機路徑或個人設定提交到 repository。

因此第一版保留 Pi 核對每個建議。`confidence` 是輸出分布的集中程度，不是完成任務的成功率。後續應先用固定案例比較提示／模型與 Pi 直接操作的品質，再決定是否值得自動連續執行；目前沒有加速或節省 Token 的實測結論。

## 資料流與限制

```text
使用者 /browser → Pi Extension → 本機 Bridge → Zen WebExtension → 指定分頁
                         ↓
                   Laya（選用、本機建議）
```

設計參考 [Jev Ultrafast](https://github.com/browser-use/jev-ultrafast/tree/1231850a0bf1a0c0341fe408ef1668dbbfdfac46) 的「觀察、列候選、選動作、重讀驗證」。Ultrafast 上游的 Chrome CDP 執行器與 Jev 決策 API 沒有直接接入本版；Zen 使用另外實作的 Gecko WebExtension。參考來源見 [NOTICE](../browser/NOTICE.md)。

Bridge 不把頁面內容另存日誌，但 Pi 的工具結果會進入目前 Session，也可能送往使用者選定的 Pi 模型 provider。Laya 推論在 Pi 主機；設定 SSH 模式時則在指定的 Workstation。網頁文字視為不可信資料，不得改變原本任務與授權。

每次觀察最多回傳 80 個操作、2000 字可見文字；單一選單最多列出 24 個選項，超出會標示 `truncated`。可輸入欄位、選單和按鈕會先於連結列入候選，避免頁面上大量連結擠掉搜尋欄。Laya 的候選選項分組比較，保留每個已觀察候選參與比較；超過 Token 預算會回報錯誤，不默默裁掉選項。

以下功能尚不支援：瀏覽器網址列和設定頁、跨 frame 操作、Shadow DOM 內部控制項、Canvas 介面、拖曳、檔案上傳／下載及要求真實鍵鼠事件的網站。密碼、付款卡與 OTP 輸入欄位會排除，但這不等於完整的個資去識別化。頁面改變、目標被遮住或操作回應遺失時停止，不會自動重送點擊；遇到導頁造成的回應遺失，也需要檢查實際分頁再重新啟動。

## 開發驗證

```bash
npm run check
npm test
npm run test:browser-addon
PI_BROWSER_FLATPAK=1 npm run test:browser-addon
```

最後兩項分別使用系統 Firefox、`app.zen_browser.zen`，全程 headless，建立臨時 profile 與本機 fixture 網站；不讀取日常瀏覽器資料。測試使用 port 4319，已有 Bridge 時會直接失敗，不會終止既有服務。Flatpak 測試只授予該次 process 存取臨時測試目錄，沒有修改永久權限。

模型品質測試須在指定的實驗主機執行，另裝模型後使用：

```bash
PI_BROWSER_PYTHON=/path/to/venv/bin/python node eval/browser-laya.mjs
```

`PI_BROWSER_HOME` 可把配對與 venv 移到獨立目錄；正式 UI 不需要設定它。一般測試不載入模型，不能拿 fixture 通過宣稱模型品質。
