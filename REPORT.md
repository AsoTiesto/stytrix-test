# 實作報告

這份報告說明這個專案怎麼做、為什麼這樣做，以及每個雲端資源實際放在哪裡。測試方式與結果在 [TESTING.md](TESTING.md)。

## 這個系統在做什麼

一個多人即時協作的無限畫布：所有人共用同一張畫布，可以新增矩形、文字、圖片節點，拖曳移動，多個瀏覽器同時開啟時彼此的操作即時同步，也能看到對方的游標。節點資料存在 Cloudflare D1，圖片檔存在 Cloudflare R2，登入走 Google OAuth。

## 資源放在哪裡

| 資源 | 名稱 / 位置 | 在 Cloudflare 後台的位置 |
|------|------------|--------------------------|
| 部署（Workers） | Worker 名稱 `stytrix-test`，網址 https://stytrix-test.stytrix-test.workers.dev | Compute（Workers & Pages）→ stytrix-test |
| 資料庫（D1） | `stytrix-db`，database_id `d947b9ec-0db5-4df9-8caf-dcb93cd349a9`，只有一張 `nodes` 表 | Storage & databases → D1 → stytrix-db |
| 檔案儲存（R2） | bucket `stytrix-files`，圖片的 key 格式是 `img/<uuid>` | Storage & databases → R2 → stytrix-files |
| 即時同步（Durable Object） | class `CanvasRoom`，跟著 Worker 一起部署，不是獨立資源 | Compute → stytrix-test → Bindings |
| Google OAuth | Client ID 寫在 `wrangler.jsonc` 的 vars；Client Secret 用 `wrangler secret put GOOGLE_CLIENT_SECRET` 設定，不在程式碼裡 | Worker 的 Settings → Variables and Secrets |

這些綁定都定義在 repo 根目錄的 `wrangler.jsonc`：Worker 程式碼裡用 `env.DB` 拿到 D1、`env.FILES` 拿到 R2、`env.ROOM` 拿到 Durable Object。資料表結構在 `schema.sql`，用 `npx wrangler d1 execute stytrix-db --remote --file=schema.sql` 建立。

題目寫「部署 Cloudflare Workers / Pages」，這裡選 Workers 而不是 Pages：一個 Worker 同時負責回靜態網頁（React build 出來的檔案）和跑 API，只需要部署一個東西，也只有一個網址要管。`wrangler.jsonc` 裡設定 `/api/*` 的請求先進 Worker 程式，其他路徑直接回靜態檔。

## 整體架構

前端是 React + Vite + TypeScript，build 出來的靜態檔和後端 API 都放在同一個 Worker：

1. 瀏覽器開啟網址，Worker 回 React 頁面。
2. 頁面載入後打 `GET /api/nodes`，從 D1 撈出所有節點畫到畫布上。
3. 同時開一條 WebSocket 連到 `/api/ws`，Worker 把這條連線轉交給 Durable Object（CanvasRoom）。
4. 之後所有操作（新增、拖曳、改文字、刪除、游標移動）都走這條 WebSocket 送給 CanvasRoom，由它寫入 D1 並廣播給其他人。

## 為什麼即時同步要用 Durable Object

Worker 本身是無狀態的：每個請求可能落在不同機器上，彼此看不到對方，所以沒辦法把「目前連線中的所有人」放在 Worker 裡。Durable Object 的特性是同一個名字全世界只會有一個實體，所有 WebSocket 連線都會集中到它身上，它自然就成了房間：手上有全部連線，誰做了什麼就轉發給其他人。這也是 Cloudflare 官方做即時協作的標準做法。目前整站只有一個房間（名字固定叫 `main`），對應「全站共用一張畫布」的設計。

## 拖曳為什麼不是每一步都存資料庫

拖曳一個節點，滑鼠每秒會產生幾十個移動事件。如果每個事件都寫 D1，資料庫會被灌爆，而且使用者根本不在乎中間經過的位置，只在乎最後停在哪。所以拆成兩條路：

- 拖曳過程中，位置更新只透過 WebSocket 廣播給其他人（每 40 毫秒最多一次），讓別人的畫面跟得上，但不碰資料庫。
- 放開滑鼠那一刻，才把最終座標寫進 D1。

游標位置同理，只廣播、完全不落地，因為游標是即時資訊，重整後沒有保留的意義。

## 兩個人同時改同一個節點怎麼辦

採用 last-write-wins：誰的操作後到，就以誰為準。正規做法是 CRDT 或 OT 這類衝突合併演算法，但實作成本高出一個量級，而這個場景的衝突單位是「整個節點的位置」，兩個人同時拖同一個矩形的機率低、後果也只是位置跳一下，不值得為此付出那個複雜度。

## 登入怎麼做

走標準的 OAuth authorization code flow，全部在後端完成：

1. 使用者點登入，後端把他導到 Google 授權頁。
2. Google 帶著授權碼把使用者導回 `/api/auth/callback`。
3. 後端拿授權碼向 Google 換 token，從中取出使用者的名字、email、頭像。
4. 後端把這些資料簽名（HMAC-SHA256）後放進 HttpOnly cookie，之後每個請求靠這個 cookie 辨識身分。

session 不存資料庫、不用外部套件，原因是簽名過的 cookie 就足以防偽造，驗證也不用查表，程式碼量最小。WebSocket 連線建立時 Worker 會先讀 cookie，把使用者名字傳給 CanvasRoom，所以節點的 `created_by` 欄位是後端根據登入狀態填的，前端傳什麼都不算數。未登入者也能用畫布，建立者記為「訪客」，這是刻意的取捨：協作畫布的展示價值在於馬上能玩，不該被登入擋住。

## 圖片怎麼存

圖片檔放 R2，資料庫只存指標：拖一張圖進畫布，前端把檔案 POST 到 `/api/upload`，後端存進 R2 並回一個 key（`img/<uuid>`），前端再建立一個 image 節點，節點的 `content` 欄位存這個 key。顯示時走 `/api/files/<key>` 由 Worker 從 R2 讀出來回給瀏覽器，並帶上一年的快取（檔名含 uuid，內容不會變，可以放心快取）。資料庫不適合放二進位大檔，R2 不適合查詢結構化資料，各管各的。

## 刻意砍掉的東西

45 分鐘的時限下，砍掉的都是不影響過關的：

- 多房間 / 多畫布：全站一張畫布就能展示協作，房間管理是純加法功能。
- 畫布縮放（zoom）：只做平移。縮放牽涉座標轉換，投入產出比最差。
- 節點改大小、旋轉：同上。
- 衝突合併演算法：用 last-write-wins 頂替，理由見上面。
- 斷線補償：WebSocket 斷線會每秒自動重連，但斷線期間漏掉的更新要重整才會補回來。正規做法是重連後重新拉一次全量狀態，沒做是因為時間。

這些項目哪天要補，架構上都不用打掉重練：房間對應 Durable Object 的名字、縮放是前端 transform、重連補償是重連時多打一次 `GET /api/nodes`。
