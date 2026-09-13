# 開發與整合

Repo：<https://github.com/lao95z953/zen-pi>。

在 feature branch 與獨立 worktree 開發，檢查 diff、執行 `npm run check` 和 `npm test` 後開 PR。CI 通過再合併 main。請使用自己的 Git 身分，避免提交憑證、真實 Session、筆記內容或本機環境檔。

自動測試使用臨時 vault 和本機假 provider，不使用付費模型。這些檢查驗證程式行為；模型的教學、研究與程式品質仍需另行評估。評估題組見 [eval/README.md](../eval/README.md)。

Web UI 部署在使用者自己的電腦，手機入口可透過 Tailscale Serve。測試 Web 功能不需要開啟桌面視窗或修改真實筆記。
