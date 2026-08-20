// E2E 測試：用 Playwright 開真瀏覽器，照 L1~L5 驗收流程逐項測試
// 執行方式：node test/e2e.mjs（預設打正式站，可用 BASE_URL 覆蓋）

import { chromium } from 'playwright'

const BASE = process.env.BASE_URL || 'https://stytrix-test.stytrix-test.workers.dev'
const WS_URL = BASE.replace(/^http/, 'ws') + '/api/ws'

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}

const apiNodes = async () => (await fetch(`${BASE}/api/nodes`)).json()
const idsBefore = new Set((await apiNodes()).map((n) => n.id))

const browser = await chromium.launch()
const A = await (await browser.newContext()).newPage()

// ---------- L1 畫布 ----------

await A.goto(BASE)
await A.waitForSelector('.toolbar')
check('L1-1 開啟網址看到畫布與工具列', (await A.locator('.canvas-viewport').count()) === 1)
await A.waitForSelector('.dot.on', { timeout: 10000 }) // WebSocket 連上再開始操作

await A.click('button:has-text("矩形")')
await A.waitForSelector('.node-rect.selected')
const rectId = await A.locator('.node.selected').getAttribute('data-id')
check('L1-2 工具列新增矩形節點', !!rectId)

await A.click('button:has-text("文字")')
await A.waitForSelector('.node-text.selected')
const textId = await A.locator('.node.selected').getAttribute('data-id')
await A.dblclick(`[data-id="${textId}"]`)
await A.waitForSelector(`[data-id="${textId}"] textarea`)
await A.keyboard.press('ControlOrMeta+a')
await A.keyboard.type('E2E 測試文字')
await A.click('.canvas-viewport', { position: { x: 900, y: 620 } }) // 點空白處結束編輯
await A.waitForFunction(
  (id) => document.querySelector(`[data-id="${id}"] span`)?.textContent === 'E2E 測試文字',
  textId
)
check('L1-3 文字節點可輸入內容（雙擊進入編輯）', true)

await A.click(`[data-id="${rectId}"]`)
check('L1-4 點選節點出現選取框', (await A.locator(`[data-id="${rectId}"].selected`).count()) === 1)

const before = await A.locator(`[data-id="${rectId}"]`).boundingBox()
await A.mouse.move(before.x + before.width / 2, before.y + before.height / 2)
await A.mouse.down()
for (let i = 1; i <= 10; i++)
  await A.mouse.move(before.x + before.width / 2 + i * 12, before.y + before.height / 2 + i * 8)
await A.mouse.up()
const after = await A.locator(`[data-id="${rectId}"]`).boundingBox()
const dx = after.x - before.x
const dy = after.y - before.y
check('L1-5 拖曳節點跟著滑鼠移動', Math.abs(dx - 120) < 15 && Math.abs(dy - 80) < 15, `位移 (${dx}, ${dy})`)

// ---------- L3 協作（開第二個瀏覽器 context = 使用者 B） ----------

const B = await (await browser.newContext()).newPage()
await B.goto(BASE)
await B.waitForSelector('.dot.on', { timeout: 10000 })

await A.click('button:has-text("矩形")')
await A.waitForSelector('.node-rect.selected')
const rect2Id = await A.locator('.node.selected').getAttribute('data-id')
let syncOk = true
try {
  await B.waitForSelector(`[data-id="${rect2Id}"]`, { timeout: 5000 })
} catch {
  syncOk = false
}
check('L3-1 A 新增節點，B 不重整即時看到', syncOk)

const b0 = await A.locator(`[data-id="${rect2Id}"]`).boundingBox()
await A.mouse.move(b0.x + b0.width / 2, b0.y + b0.height / 2)
await A.mouse.down()
for (let i = 1; i <= 8; i++) await A.mouse.move(b0.x + b0.width / 2 + i * 10, b0.y + b0.height / 2 + i * 10)
await A.mouse.up()
const posA = await A.locator(`[data-id="${rect2Id}"]`).evaluate((el) => [el.style.left, el.style.top])
let moveSynced = false
try {
  await B.waitForFunction(
    ([id, l, t]) => {
      const el = document.querySelector(`[data-id="${id}"]`)
      return el && el.style.left === l && el.style.top === t
    },
    [rect2Id, posA[0], posA[1]],
    { timeout: 5000 }
  )
  moveSynced = true
} catch {}
check('L3-2 A 拖曳節點，B 即時看到位置更新', moveSynced, `目標位置 ${posA.join(', ')}`)

await A.mouse.move(400, 300)
await A.mouse.move(420, 320)
let cursorSeen = false
try {
  await B.waitForSelector('.cursor', { timeout: 5000 })
  cursorSeen = true
} catch {}
check('L3-3 B 能看到 A 的游標位置（加分項）', cursorSeen)
await B.close()

// ---------- L5 上傳（拖圖片進畫布 → R2 → 顯示） ----------

const png1x1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const imgCountBefore = await A.locator('.node-image').count()
await A.evaluate(
  ([b64]) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    const file = new File([bytes], 'e2e-test.png', { type: 'image/png' })
    const dt = new DataTransfer()
    dt.items.add(file)
    document
      .querySelector('.canvas-viewport')
      .dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: 500, clientY: 400 }))
  },
  [png1x1]
)
await A.waitForFunction((n) => document.querySelectorAll('.node-image').length > n, imgCountBefore, {
  timeout: 10000,
})
const imgLoaded = await A.waitForFunction(() => {
  const imgs = [...document.querySelectorAll('.node-image img')]
  return imgs.length > 0 && imgs.every((i) => i.complete && i.naturalWidth > 0)
}, undefined, { timeout: 10000 }).then(() => true).catch(() => false)
const imgSrc = await A.locator('.node-image img').last().getAttribute('src')
check('L5-1 拖圖片進畫布後上傳 R2 並顯示', imgLoaded, `src=${imgSrc}`)
check('L5-2 圖片節點走 R2 讀取路徑', imgSrc?.startsWith('/api/files/img%2F') || imgSrc?.startsWith('/api/files/img/'))

// ---------- L2 存檔（重整後全部還在） ----------

await A.reload()
await A.waitForSelector('.toolbar')
let persistOk = true
try {
  await A.waitForSelector(`[data-id="${rectId}"]`, { timeout: 8000 })
  await A.waitForFunction(
    (id) => document.querySelector(`[data-id="${id}"] span`)?.textContent === 'E2E 測試文字',
    textId,
    { timeout: 8000 }
  )
  await A.waitForFunction(() => {
    const img = [...document.querySelectorAll('.node-image img')].at(-1)
    return img && img.complete && img.naturalWidth > 0
  }, undefined, { timeout: 8000 })
} catch {
  persistOk = false
}
check('L2-1 重整後矩形、文字內容、圖片全部還在', persistOk)

const rows = await apiNodes()
const rectRow = rows.find((n) => n.id === rectId)
check('L2-2 節點資料寫進 D1（含拖曳後座標）', !!rectRow, rectRow ? `D1 座標 (${rectRow.x}, ${rectRow.y})` : '')

// ---------- L4 登入（自動化只能驗到 Google 授權頁前一步） ----------

const meStatus = (await fetch(`${BASE}/api/me`)).status
check('L4-1 未登入時 /api/me 回 401', meStatus === 401)

const loginRes = await fetch(`${BASE}/api/auth/login`, { redirect: 'manual' })
const loc = loginRes.headers.get('location') || ''
check(
  'L4-2 /api/auth/login 轉導 Google 授權頁且帶正確 redirect_uri',
  loginRes.status === 302 && loc.startsWith('https://accounts.google.com/') && loc.includes(encodeURIComponent(`${BASE}/api/auth/callback`))
)
check('L4-3 未登入建立的節點記錄建立者為訪客', rectRow?.created_by === '訪客', `created_by=${rectRow?.created_by}`)
// L4-4 真人 Google 登入與已登入者的 created_by 需手動驗證（自動化無法代替 Google 帳號認證）

// ---------- 清理測試資料 ----------

const idsAfter = (await apiNodes()).map((n) => n.id)
const created = idsAfter.filter((id) => !idsBefore.has(id))
if (created.length) {
  const ws = new WebSocket(WS_URL)
  await new Promise((r) => ws.addEventListener('open', r))
  for (const id of created) ws.send(JSON.stringify({ type: 'delete', id }))
  await new Promise((r) => setTimeout(r, 800))
  ws.close()
}
const leftover = (await apiNodes()).filter((n) => created.includes(n.id))
check('清理：測試建立的節點已全部刪除', leftover.length === 0, `建立 ${created.length} 個，殘留 ${leftover.length} 個`)

await browser.close()

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 項通過`)
process.exit(failed.length ? 1 : 0)
