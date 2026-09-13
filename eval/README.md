# 固定學習與研究題組

`tasks.json` 有 8 個人工情境，檢查模式切換、引用、來源更新、未解學習問題與研究中的未知。所有筆記及回答均為合成資料，不是真實使用者紀錄。

這套評估會保存模型回答、工具事件、執行時間與 Pi 回報的用量。每項判準預設 `rating: null`，需閱讀答案及來源後評定；程式完成、沒有報錯，都不代表答對。不將本機假 provider 的結果填成教學或研究分數。

一般開發可先驗證題組，這不會呼叫模型：

```bash
python3 eval/run.py --validate
```

真正模型評估在 Workstation 執行。該機器需有 Pi 0.85.1、此 repo 的依賴及已設定的模型登入；不會自動把 T14 的憑證複製過去。評估只載入本專案 extension，停用內建檔案／shell 工具及其他自動發現的擴充；此設定必須在 baseline 與候選版保持相同。由你選定 provider／model 與執行的案例，再開始計費呼叫：

```bash
python3 eval/run.py --provider <provider> --model <model> --label candidate --case study-grounded-answer
```

預設只允許目前確認的 Workstation hostname `tuf-fedora`；主機變更時先確認環境，再以 `--workstation-host` 指定。每次執行使用臨時 vault，結果留在 `eval/results/`，預設不進 Git。失敗會保留 error 並停止，不用空回答算成功。

比較 baseline 與候選版本時，保持模型、題組與評分規則相同，另記錄設定差異與執行順序。每個判準以 `pass`／`partial`／`fail` 評定並附答案或工具事件依據；尚未人工複查時維持 null。費用未知時保持未知，不把 token 字數換算成帳單。

本次交付建立題組與執行器，沒有進行付費模型品質比較。
題組格式已在 T14 與 Workstation `tuf-fedora` 驗證通過。Workstation 當時有 Python 3，尚未找到 Node／Pi，因此本次未在該機安裝模型環境或登入帳號。
