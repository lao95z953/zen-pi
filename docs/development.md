# 開發與整合

Repo：<https://github.com/lao95z953/zen-pi>。

在 feature branch 與獨立 worktree 開發，檢查 diff、執行 `npm run check` 和 `npm test` 後開 PR。CI 通過再合併 main。請使用自己的 Git 身分，避免提交憑證、真實 Session、筆記內容或本機環境檔。

自動測試使用臨時 vault 和本機假 provider，不使用付費模型。這些檢查驗證程式行為；模型的教學、研究與程式品質仍需另行評估。評估題組見 [eval/README.md](../eval/README.md)。

Web UI 部署在使用者自己的電腦，手機入口可透過 Tailscale Serve。測試 Web 功能不需要開啟桌面視窗或修改真實筆記。

測試入口會建立自己的臨時設定，直接執行單個測試也不繼承個人 `PI_RONNY_CONFIG`、`PI_STUDY_VAULT` 或 `PI_LLM_WIKI`。要測其他設定，案例應在載入測試 helper 後自行建立 fixture。

Web 版面另以真正瀏覽器驗證長對話、側欄捲動和固定工具列：

```bash
npx playwright install chromium firefox
npm run test:web-layout
```

瀏覽器以 headless 執行，使用假對話與本機 fixture server，不載入個人 Session、不呼叫模型。
