---
name: blind-timing-oracle
description: 遠端服務吞掉 stderr、成功失敗都秒斷線、完全沒有回顯時,用執行時間當布林 oracle。用在盲打 pickle/deserialize jail、探測 find_class 白名單、做版本指紋,以及任何「沒有輸出可看」的遠端探測。
---

# 沒有回顯時,用時間當 oracle

## 適用情境

題目服務只把 stdout 接到 socket,traceback 走 stderr 直接不見,成功和失敗都是秒斷線。這時不要盲猜。

## 做法

讓 payload 在**成功**的路徑尾巴接一個無窮迴圈。失敗就會提早結束,成功就卡住 —— 執行時間變成一個乾淨的布林值。

pickle 版的無窮迴圈:

```python
deque(_repeat(0), 0)   # maxlen=0,C 層空轉,不吃記憶體
```

實測基準:失敗約 0.1 秒、卡住約 3.0 秒(服務端 alarm 切掉)。差距夠大,不需要統計處理。

## 拿它來做什麼

一個一個試 `find_class` 允許哪些名字、哪個 gadget 存在。等於免費的版本指紋。

## 先在本地跑通

```bash
uv python install 3.8 3.9
```

裝對應版本先在本機跑通再打遠端,比盲打快非常多。

## 同一套思路的其他形狀

「沒有回顯就找可觀測的副作用」還有兩個變形:

- 只能用 `\w` 字元的環境:靠 `sleep` 做布林。
- 檔案上傳的任意寫:拿四種不同的例外訊息當檔案系統偵察。

## 別跟這個搞混

請求 timeout **不一定**是 oracle 在動作 —— 使用者的兩條網路都會在封包層吞掉攻擊 payload。
先拿同一個 payload 打一台不相干的主機確認,再開始解讀時間差。
