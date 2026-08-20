# stytrix-test — 多人即時協作無限畫布

## 部署網址

https://stytrix-test.stytrix-test.workers.dev

## 已完成關卡

- [x] L0 上線 — public repo + React app 部署到 Cloudflare
- [x] L1 畫布 — 新增矩形與文字節點、拖曳移動、點選選取
- [x] L2 存檔 — 節點寫入 D1，重整後內容還在
- [x] L3 協作 — 多瀏覽器即時同步，含他人游標顯示
- [x] L4 登入 — Google OAuth，畫面顯示登入者，節點記錄建立者
- [x] L5 上傳 — 圖片存進 R2，畫布顯示，重整後仍在

## AI 開發工作流說明

整個專案用 Claude Code（Fable 5）開發：人負責 Cloudflare 帳號授權與 Google OAuth 憑證，其餘的 code、部署、驗證都由 AI 完成，每一關用 script 實測通過後才 commit。為了在 45 分鐘內把六關做完，刻意砍掉了多房間（全站共用一張畫布）、畫布縮放、節點改大小，編輯衝突直接採 last-write-wins。同步協定也選了最簡單的做法：拖曳過程只透過 WebSocket 廣播，放開滑鼠才寫進 D1，用最少的資料庫寫入量換到即時性。

## 相關文件

- [REPORT.md](REPORT.md)：實作邏輯報告，含每個雲端資源（D1、R2、Workers、Durable Object）的名稱與後台位置
- [TESTING.md](TESTING.md)：測試流程與結果，E2E 16 項全數通過

## 技術棧

React + Vite + TypeScript / Cloudflare Workers（靜態資源 + API）/ Cloudflare D1 / Cloudflare R2 / Google OAuth
