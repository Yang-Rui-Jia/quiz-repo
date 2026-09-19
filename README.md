# 現場互動測驗 × LINE

參加者掃 QRCode → 在 LINE 內開啟測驗頁（LIFF）→ 一頁作答 → 確認頁可改答案 → 送出後立即看到成績，
並可一鍵請官方帳號用 **Reply API（免費、無上限）** 回覆成績到 LINE。全部使用免費資源。

**題目與正解不公開**：它們存在你的 Google Sheet，只有後端（Apps Script）讀得到。玩家通過 LINE 身分驗證後才會拿到題目（不含正解），成績也由後端比對正解後算出。

## 文件

| 文件 | 給誰 | 內容 |
|---|---|---|
| [docs/01-管理者建置教學.md](docs/01-管理者建置教學.md) | 系統擁有者 | 從申請 LINE 官方帳號開始，一步步建好整個系統 |
| [docs/02-出題者操作手冊.md](docs/02-出題者操作手冊.md) | 出題的人 | 怎麼用後台出題、產生 QRCode、看結果（只需要後台網址 + 管理密碼） |
| [project.md](project.md) | 開發參考 | 原始規格（部分設計已被下面的差異表取代） |

## 專案結構

```
├── index.html            首頁（連結到後台與示範）
├── config.js             全站設定（LIFF ID、GAS 網址、官方帳號 ID）← 擁有者填一次
├── play/index.html       玩家答題頁（LIFF）
│   └ sample-quiz.json    只給「?mock=1 測試模式」用的內建示範題目
├── admin/                管理後台：題庫、測驗編輯、QRCode、結果統計
├── gas/Code.gs           Google Apps Script 後端 = 資料庫 + API + LINE webhook
└── assets/qrcode.js      QRCode 產生函式庫（qrcode-generator，MIT 授權）
```

## 架構

```
玩家手機 LINE ──掃碼──▶ LIFF (GitHub Pages: play/)
                          │ ① start：LIFF access token
                          ▼
                   Google Apps Script ──▶ 驗證身分 → 回傳題目（不含正解）
                          ▲                 資料存在 Google Sheet：測驗 / 題庫 / 作答紀錄
                          │ ② submit：玩家選的答案 → 後端比對正解、算分、寫入 → 回傳分數
   玩家按「查詢成績」→ 聊天室送出預填訊息 → LINE webhook → Reply API 回覆成績

管理後台 (GitHub Pages: admin/) ──管理密碼──▶ Apps Script：讀寫題庫與測驗、查看結果
```

## 與原始規格 (project.md) 的差異

| 項目 | 規格 | 實作 | 原因 |
|---|---|---|---|
| 題目與正解存放 | GitHub Repo 的 .txt / .json（公開） | **Google Sheet（後端）** | 不讓題目與正解公開；出題者也不再需要 GitHub 帳號 |
| 算分 | 前端計算 | **後端計算** | 正解不下發到手機 |
| 管理後台登入 | GitHub Token | **管理密碼（ADMIN_KEY）** | 資料改存後端，不再寫 GitHub |
| LIFF 建立位置 | 在 Messaging API channel 下 | 在同 Provider 的 **LINE Login channel** 下 | LIFF 只能加在 LINE Login channel |
| 玩家身分 | 前端傳 userId | 後端用 LIFF access token 向 LINE 驗證 | 防止冒用他人 userId |
| 「已作答」被擋 | 待決定 | 顯示上次成績 + 「請洽現場工作人員」 | 見規格第 10 節 |
| 送出網路重試 | 未規劃 | 每次送出帶 submissionId，後端去重 | 網路不穩重送不會重複記錄 |
