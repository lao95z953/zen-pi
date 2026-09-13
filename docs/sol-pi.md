# SoL-Pi 整合

Zen Pi 可以另外安裝 [NVIDIA SoL-Pi](https://github.com/NVlabs/SoL-Pi)。這個 repo 只提供配置範例 `config/sol-pi.json`，不包含 SoL-Pi 原始碼，也不會自動啟用它。

配置範例開啟 Action Fusion 與 ObservationPack，關閉 Evidence-Preserving Reducer 和 Online Context Compact。Action Fusion 可讓 `edit`／`write` 接受 `then_run`，在檔案修改成功後執行已選定的檢查命令；命令失敗不會還原已完成的修改。ObservationPack 將大型成功工具輸出保存到 Session 目錄，後續以 ID 和片段交付，模型需要原文時可用 `obs_recall` 分頁讀取。

固定版本的安裝範例：

```bash
npm_config_ignore_scripts=true npm_config_omit=dev npm_config_legacy_peer_deps=true pi install git:github.com/NVlabs/SoL-Pi@d7ecfc089944f0d04b80122a0a9a6ca0d786f3d0
```

把 `config/sol-pi.json` 放到 Pi 的使用者設定目錄，先檢查既有檔案再修改，然後在 Pi 執行 `/reload` 或開新 Session。若專案同時載入舊 guardrails、CTF 命令前綴或自訂 bash 執行器，先關閉 Action Fusion，直到相容性經過驗證。

SoL-Pi 的節省量是估計值，不是模型帳單；ObservationPack 也只能回查當時保存的工具輸出。以 `--no-session` 啟動時沒有持久 Session 目錄，大型輸出會維持全文。Zen Pi 自己的 `study_wiki`／`study_observe` 成功後回傳收據，完整內容可依 ID 用 `study_memory` 查回。

停用單一機制可在設定中將對應布林值改為 `false`，再重新載入。移除 SoL-Pi：

```bash
pi remove git:github.com/NVlabs/SoL-Pi@d7ecfc089944f0d04b80122a0a9a6ca0d786f3d0
```

專案測試含本機假 provider 與可選的 SoL-Pi 整合測試；要執行整合測試，可用 `PI_SOL_PI_ROOT` 指定已安裝的 SoL-Pi 原始碼。Fixture 測試不代表在真實模型上的成本或答案品質提升。
