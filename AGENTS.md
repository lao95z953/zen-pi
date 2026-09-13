# Zen Pi 開發規則

- 使用 feature branch 與獨立 worktree 開發；提交前審查 diff，執行 `npm run check` 與 `npm test`，經 PR 與 CI 檢查後合併。
- 不提交憑證、真實對話、筆記庫內容或個人環境設定。測試使用臨時 vault 和本機假 provider。
- Web server 只監聽 loopback。遠端存取使用 Tailscale Serve，不啟用 Funnel 或關閉 Origin／Host 檢查。
- Pi 本體保持未修改；依賴版本固定。修改 Sub Agent 與 Session 管理時保留既有資料格式的相容性。
