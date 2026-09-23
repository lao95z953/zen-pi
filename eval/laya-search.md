# Laya 搜尋決策微調實驗

目標是改善 Zen Browser Bridge 在搜尋流程中的下一步建議。Jev-Ultrafast 是參考的瀏覽器操作迴圈；本實驗沿用 Zen 的 Gecko WebExtension、候選 action ID 與 Pi 核對機制，沒有改用 Jev 的 Chrome 執行器或 API。

`build-laya-search-data.mjs` 從固定模板產生搜尋狀態和標籤。訓練包含 6 種網站樣式、8 個查詢詞、8 個階段，題目使用 `browser/decisions.mjs` 的實際候選描述。保留集使用另外 2 種網站樣式和 6 個查詢詞，共 96 個案例。每個網站樣式可有多個階段；同一網站不會同時進入訓練與保留集。這是合成資料，不能代表一般網站任務成功率。

`capture-laya-search-live.py` 在暫存的 headless Firefox profile 中執行 Zen 自己的 DOM observer。`train` 模式擷取 Gutenberg、Python.org、Wiktionary、Bing、PyPI、npm 等公開網站的搜尋狀態；部分填字後狀態由同一頁的欄位值衍生。未指定模式時擷取 Wikipedia、DuckDuckGo、Mojeek、Google 中文首頁和 Yahoo 作為獨立檢查。它不讀取日常瀏覽器 profile，不截圖；結果頁若沒有可見的查詢證據會直接失敗。網站會變動，因此要保存每次執行的 JSONL 和日期。這項檢查只衡量單步建議，不等於完成整個瀏覽器任務。

2026-09-23 在 Workstation 執行的固定檢查如下。三個模型都使用同一批當天擷取的頁面、同一份合成保留集及同一版決策輸入；推論用 CPU。公開頁面檢查與訓練頁面來自不同網站，但只有 9 個狀態，分數不能推論一般網站的成功率。

| 模型 | 公開頁面單步選對 | 合成保留集單步選對 | 原有一般操作案例選對 |
| --- | ---: | ---: | ---: |
| 固定 revision 的 Laya Multilingual | 3/9 | 16/96 | 2/10 |
| 合成資料後接公開頁面微調的 v3 | 5/9 | 92/96 | 4/10 |
| 加入 URL 與新版候選排序再微調的 v5 | 5/9 | 91/96 | 5/10 |

v5 是目前供明確設定後試用的版本。它仍會把 Wikipedia 搜尋首頁誤判為 `DONE`，也會把 DuckDuckGo 首頁和 Google 中文首頁選成其他 click。Pi 必須核對建議；目前沒有端到端搜尋任務或延遲數字。v5 的訓練鏈是：固定 revision 的基礎模型 → 1,872 題合成資料、encoder 與決策頭訓練 3 epochs → 3,690 題混合資料、只訓練決策頭 2 epochs → 3,903 題新版混合資料、只訓練決策頭 1 epoch。三份訓練 JSONL 的 SHA-256 依序為 `5127031498d19d3638346f9d59c7e49a5197277bd7b97194226a049c39ff2393`、`98de88740c8afe39bae0ec66eafaf94ca2c0d93ea254e2af059ddadfee5aaff4`、`253e2df82681dc36c5b4c02b1aad4fb9eb8d306ef7901931df84fd855b1daa0b`。checkpoint 和原始 JSONL 留在 Workstation 實驗目錄，未提交 Git。

預設訓練只更新 Laya 的決策頭，encoder 凍結。設定 `LAYA_SEARCH_TRAIN_ENCODER=1` 可連 encoder 一起微調，並啟用 gradient checkpointing；此模式在 8 GB GPU 上接近容量上限。輸出為完整的本機 Laya checkpoint。模型不會自動取代預設版；需明確設定 `PI_BROWSER_LAYA_MODEL_DIR` 才會載入。`confidence` 尚未在真實網站校準，Pi 仍要核對每個建議與完成條件。

在 Workstation、從 repository 根目錄執行。訓練環境需安裝 `laya==0.3.4`、CUDA 版 `torch==2.8.0`、`transformers==4.57.6`、`huggingface-hub==0.36.0`、`safetensors==0.6.2` 與 `numpy==2.2.6`；擷取環境另需 Selenium 與 headless Firefox。先依 `docs/browser.md` 下載固定 revision 的 Laya Multilingual checkpoint。以下指令示範從基礎 checkpoint 訓練一次新版本；上表 v5 使用前段記錄的三段訓練鏈。

```bash
python eval/capture-laya-search-live.py eval/results/laya-search/real-train.jsonl train
python eval/capture-laya-search-live.py eval/results/laya-search/live-holdout.jsonl
node eval/build-laya-search-data.mjs eval/results/laya-search eval/results/laya-search/real-train.jsonl
PI_BROWSER_PYTHON=/path/to/gpu-venv/bin/python node eval/browser-laya.mjs eval/results/laya-search/holdout.jsonl > eval/results/laya-search/baseline.json
LAYA_SEARCH_TRAIN_ENCODER=1 LAYA_SEARCH_DATA_NAME=public-search-mix-v1 python eval/train-laya-search.py eval/results/laya-search/train.jsonl /path/to/base-checkpoint /path/to/search-checkpoint
PI_BROWSER_PYTHON=/path/to/gpu-venv/bin/python PI_BROWSER_LAYA_MODEL_DIR=/path/to/search-checkpoint PI_BROWSER_LAYA_DEVICE=cuda node eval/browser-laya.mjs eval/results/laya-search/holdout.jsonl > eval/results/laya-search/tuned.json
PI_BROWSER_PYTHON=/path/to/gpu-venv/bin/python PI_BROWSER_LAYA_MODEL_DIR=/path/to/search-checkpoint PI_BROWSER_LAYA_DEVICE=cuda node eval/browser-laya.mjs eval/results/laya-search/live-holdout.jsonl > eval/results/laya-search/live-tuned.json
```

基線與微調版必須評估同一個 `holdout.jsonl`。`eval/browser-laya.mjs` 也保留原來的 10 個 smoke cases；不帶參數時執行它們。檢查 `results` 中的錯誤與各階段分數，不能只看總分。模型檔、訓練資料和評估輸出都留在忽略 Git 的 `eval/results/` 或 Workstation 實驗目錄，不提交個人瀏覽資料。
