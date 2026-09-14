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

側欄依 Workspace 顯示對話。既有 CLI Session 可唯讀檢視；按「接續對話」會建立 Web 分支，原紀錄仍保留。Side Chat、Fork 和接續分支顯示在 parent 底下，可展開、重新命名、移到回收清單及還原。刪除單筆不會刪除子對話或 Pi 的原始 Session 檔，也不會釋放磁碟空間。

左右側欄與上方工具可各自收合；「專注閱讀」會收起三個區域，版面偏好保存在目前瀏覽器。串流回覆時可向上捲動閱讀，按「回到最新內容」才恢復跟隨。

模型提供思考文字時，對話中會即時展開「思考過程」；可手動收合，歷史對話預設收合。模型若只回報推理 Token 而沒有可顯示文字，介面會提示未提供內容，不會自行生成思考文字。

對話中的 `mermaid` 程式碼區塊會在訊息完成後顯示成圖表。可放大、縮小、展開原始碼或複製原始碼；語法錯誤時保留原始碼。Mermaid 程式庫由本機 Web 服務提供，不連接圖表 CDN。開發時修改 Mermaid 或 KaTeX 版本後執行 `npm run build:web` 更新打包檔。

對話中的 LaTeX 算式會排版成 MathML。獨立成行的 `$$…$$` 或 `\[…\]` 顯示為置中算式，`\(…\)`、`$$…$$` 與 `$…$` 顯示為行內算式。`$…$` 要含 TeX 指令，或是不以數字開頭的短字串，才會當成算式；這是為了不把金額當成算式。排版走 MathML 而不是 KaTeX 自家的 HTML 輸出，因為後者靠行內 style 定位，會被 Web 服務的 CSP 擋下；MathML 由瀏覽器排版，不必放寬 CSP，也不必另外提供字型檔。語法有誤時保留原始 LaTeX，並把 KaTeX 的錯誤說明放進提示。KaTeX 程式庫由本機 Web 服務提供，不連接 CDN。

輸入區的「紀錄」在中央主視窗開啟 Transcript，包含訊息、模型提供的思考文字、工具參數與結果。常見憑證欄位會遮蔽，但不要把 Web UI 當成可安全分享的公開日誌。Token 區分本輪回報、目前上下文估計和載入分支歷史累計；歷史累計含反覆讀取的快取，不等於上下文大小或實際帳單。

## 圖片

在輸入框按 `Ctrl+V` 可貼上剪貼簿圖片；手機可點圖片按鈕選擇照片。加入後顯示縮圖，按 × 移除，按縮圖放大。支援 PNG、JPEG、WebP、GIF；每則最多 4 張、每張 5 MiB、合計 8 MiB。圖片先存到 Web 服務所在電腦的圖片快取，送出時才交給 Pi 模型；不另上傳第三方圖床。只送圖片時會附上「請查看這些圖片。」。

圖片草稿依 Workspace／Session 分開保存。生成中可將圖片「立即補充」或「排到下一輪」；清空、停止或傳送失敗會把未交付圖片恢復至原草稿。恢復後若超過單次限制，先整理附件再送出。Slash 指令不能附圖片；模型不支援圖片時會顯示原因並保留草稿。

## 指令與 Sub Agent

輸入 `/` 可搜尋指令。常用項目有 `/model`、`/thinking`、`/new`、`/name`、`/session`、`/compact`、`/fork`、`/clone`、`/side`、`/export` 和 `/agents`。Study／Research 指令由 extension 提供。`/help` 顯示目前可用指令；`/login`、`/settings`、`/reload` 仍需在 Pi 終端使用。

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
| `PI_STUDY_VAULT` | Obsidian vault 絕對路徑；使用 Study 時設定 |

服務狀態與紀錄：

```bash
systemctl --user status zen-pi-web.service
journalctl --user -u zen-pi-web.service -n 50
```

程式或設定更新後，請在背景回覆與 Sub Agent 完成時重新啟動服務；重啟會結束 Pi 程序，未交付佇列不會自動重送。本版沒有公網登入或多人帳號功能。
