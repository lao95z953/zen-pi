# Zen Pi Web UI

Web UI 連接本機 Pi 與模型登入，依 Workspace 列出 Web 和 Pi CLI Session。它可以建立對話、切換一般／Study／Research 模式、閱讀 Transcript、管理 Side Chat、Fork 和 Sub Agent。

## 本機啟動

在安裝依賴並執行 `pi install .` 後：

```bash
npm run web
```

開啟 <http://127.0.0.1:4318>。服務只監聽 `127.0.0.1`。Web Session 與索引預設保存在 `~/.local/share/zen-pi-web/`，可用 `PI_WEB_DATA_DIR` 指定別處。模型憑證由 Pi 讀取，Web 不複製 `auth.json`。

Study 模式需設定 `PI_STUDY_VAULT` 為已存在的 Obsidian vault 絕對路徑，並在該 vault 啟用 Zen Pi Study Bridge。新增 Workspace 時選擇已存在的資料夾；Pi 的工作目錄與檔案操作會跟著切換。

## 手機與 Tailscale

手機可加入同一 tailnet，再用 [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve) 提供 HTTPS。請將下面的網址和登入身分換成自己的值；不要啟用 Funnel 或把 Web server 改成公網監聽。

```bash
node scripts/install-web-service.mjs \
  --origin https://your-device.your-tailnet.ts.net \
  --tailscale-user you@example.com \
  --vault /path/to/your/vault
tailscale serve --bg --yes http://127.0.0.1:4318
```

`--vault` 只在使用 Study 時需要。安裝器會建立 `~/.config/systemd/user/zen-pi-web.service` 與 `~/.config/zen-pi-web/environment`，既有檔案先備份。Tailscale 登入與裝置授權仍由 tailnet 管理；Web 額外檢查請求的 Host、Origin 和 `tailscale-user-login` 是否符合設定。手機需連上 tailnet，運行 Web UI 的電腦需保持開機和連線。

## Session 與版面

側欄依 Workspace 顯示對話。CLI Session 的新增與完整寫入會自動更新；尚未由原生 Pi 終端開啟的舊紀錄保持唯讀，按「接續對話」會建立 Web 分支，原紀錄仍保留。Side Chat、Fork 和接續分支顯示在 parent 底下，可展開、重新命名、移到回收清單及還原。刪除單筆不會刪除子對話或 Pi 的原始 Session 檔，也不會釋放磁碟空間。

## CLI 與 Web 同步

Web 建立的對話由 Web 服務中的 Pi 程序執行。要在終端同時操作，在 Zen Pi 專案目錄執行：

```bash
npm run cli -- attach
```

終端客戶端會加入 Web 目前選取的 Session；Web 與終端的訊息、串流回覆會即時出現在兩邊。終端可用 `/sessions` 查看 ID、`/open <ID>` 切換、`/new` 建立、`/follow` 排到下一輪、`/steer` 立即補充、`/stop` 停止、`/exit` 離開。Web 正在回覆時，終端送出的一般訊息會自動排入下一輪。服務使用其他 port 時加上 `--url http://127.0.0.1:<port>`；客戶端只接受本機 loopback。Web 側欄下方的「在終端同步對話」也會顯示啟動指令。若執行 `npm link` 安裝專案提供的命令，亦可使用 `zen-pi attach`。

原生 `pi` TUI 載入新版 Zen Pi Extension 後，會在私有 Unix socket 公布目前 Session 的即時事件。Web 開啟同一筆本機對話時會接入該程序，兩邊都能傳送一般文字；Web 可停止生成，圖片、Slash 指令、模型切換、Sub Agent 等進階操作留在原生 TUI。原生 TUI 關閉後，Web 回到自動更新的唯讀紀錄。單一程序持有寫入權；第二個載入此 Extension 的 Pi 程序若開啟同一檔案，會退出以避免並行寫入。Pi 在 Extension 啟動前可能已讀取或遷移 Session，未載入 Extension 的外部程序也不受這項防護；請用上述終端客戶端加入 Web 對話，不要另用 `pi --session <Web 檔案>` 同時寫入。

若 Pi 異常關閉並留下 Session socket，下一個程序會拒絕接管。先確認 Web 與原生 Pi 都沒有使用該 Session，再依錯誤訊息中的路徑移除遺留 socket，重新開啟對話。

左右側欄與上方工具可各自收合；「專注閱讀」會收起三個區域，版面偏好保存在目前瀏覽器。版面固定在目前視窗內：上方版面按鈕與輸入框保持可見，長對話、對話清單及右側內容各自捲動。右側的關閉按鈕和分頁不會跟著來源清單捲走。串流回覆時可向上捲動閱讀，按「回到最新內容」才恢復跟隨。

觸控板雙指縮放時，版面依瀏覽器實際可見範圍重新排列，保留文字放大效果，控制列與輸入框會跟著可見範圍移動；對話框也在這個範圍內開啟。

模型提供思考文字時，對話中會即時展開「思考過程」；可手動收合，歷史對話預設收合。模型若只回報推理 Token 而沒有可顯示文字，介面會提示未提供內容，不會自行生成思考文字。

對話中的 `mermaid` 程式碼區塊會在訊息完成後顯示成圖表。可放大、縮小、展開原始碼或複製原始碼；語法錯誤時保留原始碼。Mermaid 程式庫由本機 Web 服務提供，不連接圖表 CDN。開發時修改 Mermaid 或 KaTeX 版本後執行 `npm run build:web` 更新打包檔。

對話中的 LaTeX 算式會排版成 MathML。獨立成行的 `$$…$$` 或 `\[…\]` 顯示為置中算式，`\(…\)`、`$$…$$` 與 `$…$` 顯示為行內算式。`$…$` 要含 TeX 指令，或是不以數字開頭的短字串，才會當成算式；這是為了不把金額當成算式。排版走 MathML 而不是 KaTeX 自家的 HTML 輸出，因為後者靠行內 style 定位，會被 Web 服務的 CSP 擋下；MathML 由瀏覽器排版，不必放寬 CSP，也不必另外提供字型檔。語法有誤時保留原始 LaTeX，並把 KaTeX 的錯誤說明放進提示。KaTeX 程式庫由本機 Web 服務提供，不連接 CDN。

輸入區的「紀錄」在中央主視窗開啟 Transcript，包含訊息、模型提供的思考文字、工具參數與結果。常見憑證欄位會遮蔽，但不要把 Web UI 當成可安全分享的公開日誌。Token 區分本輪回報、目前上下文估計和載入分支歷史累計；歷史累計含反覆讀取的快取，不等於上下文大小或實際帳單。

## 圖片

在輸入框按 `Ctrl+V` 可貼上剪貼簿圖片；手機可點圖片按鈕選擇照片。加入後顯示縮圖，按 × 移除，按縮圖放大。支援 PNG、JPEG、WebP、GIF；每則最多 4 張、每張 5 MiB、合計 8 MiB。圖片先存到 Web 服務所在電腦的圖片快取，送出時才交給 Pi 模型；不另上傳第三方圖床。只送圖片時會附上「請查看這些圖片。」。

圖片草稿依 Workspace／Session 分開保存。生成中可將圖片「立即補充」或「排到下一輪」；清空、停止或傳送失敗會把未交付圖片恢復至原草稿。恢復後若超過單次限制，先整理附件再送出。Slash 指令不能附圖片；模型不支援圖片時會顯示原因並保留草稿。

## 指令與 Sub Agent

輸入 `/` 可叫出補全，或按輸入框下方的「/ 指令」開啟搜尋面板；可用名稱、用途及子指令搜尋，不必記住英文指令。Tab 填入目前選項；Enter 會補全未完成的名稱，指令完整時送出。面板會顯示使用方式；已有一般訊息草稿時仍可搜尋，但須先送出或清空草稿才能填入指令。常用項目有 `/model`、`/thinking`、`/new`、`/reload`、`/name`、`/session`、`/compact`、`/fork`、`/clone`、`/side`、`/export` 和 `/agents`。Study／Research 指令由 extension 提供。`/help` 也會開啟搜尋面板；`/login`、`/settings` 等終端專用指令仍需在 Pi 終端使用。

Web 對話閒置時可輸入 `/reload`，它會保留已保存的 Session，重新啟動該對話的 Pi process 並載入已安裝的 extension 與設定；Pi 離線且設定已修復時也可用它重新連線。正在回覆或有 Sub Agent 執行時會拒絕。原生 Pi 終端控制的對話仍須在該終端執行 `/reload`。這個指令不重啟 Web server；更新 Web 程式碼或服務環境變數後仍須重啟服務。

指令的簡短提示可用右側 × 收起。Extension 回傳的指令結果會顯示在對話及 Transcript，直到 Web 服務重啟或該對話執行 `/reload`；執行失敗會保留原本的輸入草稿。

Sub Agent 有獨立 Pi Session，可執行閱讀分析或在 Git worktree 修改程式。主 Agent 與 Web 面板都能建立任務；子任務結果需檢查後再整合。詳見 [Sub Agent](subagents.md)。

## 設定與維護

| 環境變數 | 用途 |
|---|---|
| `PI_WEB_PORT` | 本機 port，預設 4318 |
| `PI_WEB_WORKSPACE` | 初始 Workspace，預設使用者 home |
| `PI_WEB_DATA_DIR` | Web Session 與索引目錄 |
| `PI_WEB_SESSION_ROOTS` | 額外 Pi Session 目錄，Linux 以 `:` 分隔 |
| `PI_WEB_PI_BIN` | Pi executable，預設 PATH 中的 `pi` |
| `PI_WEB_PUBLIC_ORIGIN` | Tailscale 的完整 HTTPS origin |
| `PI_WEB_TAILSCALE_USER` | 允許操作的 Tailscale 登入身分 |
| `PI_LLM_WIKI` | 預設 LLM Wiki 的絕對路徑，預設 `~/.pi/llm-wiki` |
| `PI_STUDY_VAULT` | Obsidian vault 絕對路徑；使用 Study 時設定 |

服務狀態與紀錄：

```bash
systemctl --user status zen-pi-web.service
journalctl --user -u zen-pi-web.service -n 50
```

程式或設定更新後，請在背景回覆與 Sub Agent 完成時重新啟動服務；重啟會結束 Pi 程序，未交付佇列不會自動重送。本版沒有公網登入或多人帳號功能。
