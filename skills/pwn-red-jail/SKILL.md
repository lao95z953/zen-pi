---
name: pwn-red-jail
description: 處理 Dockerfile 出現 `FROM pwn.red/jail` 的 pwn 題。用在 exploit 本地跑得通、打遠端卻「看起來沒執行到」的時候,以及要決定 ORW/FSOP 該用哪個 fd、要怎麼在本地忠實重現遠端環境的時候。
---

# pwn.red/jail 的 fd 陷阱

## 先確認是不是這個環境

題目 Dockerfile 裡有 `FROM pwn.red/jail`,就適用。

## 核心事實

jailed process 的 **fd 1 是連線,fd 2 不是**。往 stderr 寫的東西通通回不到客戶端:

- `__stack_chk_fail` 印的 `*** stack smashing detected ***`
- `__libc_message` 的 abort 訊息
- FSOP 打 `_IO_2_1_stderr_` 的產出

本地用 pipe 跑這些全都看得到,所以很容易誤判成「exploit 根本沒執行到」,然後回頭去改一個其實沒壞的 exploit。

## 怎麼做

- ORW 最後那段 `write()` 用 **fd 1**。
- FSOP 挑 `_IO_2_1_stdout_`,不要挑 stderr。
- 遠端沒有輸出但本地有,先假設是 fd 的問題,不要先改 exploit 邏輯。

## 本地重現遠端環境

要看到跟遠端一樣的行為,得把**整個 jail 跑起來**,只跑 runtime stage 不算:

```bash
docker build -t chal . && docker run -d --privileged -p 15000:5000 chal
```

landlock、seccomp、socket fd 會照題目設定全部生效,是最忠實的測試環境。

rootless podman 會在 `mknod /srv/dev/null` 掛掉,要用 docker 或 `sudo podman`。

## 相關

沒有回顯時改用執行時間當 oracle,見 `blind-timing-oracle` skill。
