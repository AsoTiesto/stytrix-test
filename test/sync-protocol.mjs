const BASE = 'https://stytrix-test.stytrix-test.workers.dev'
const WS = 'wss://stytrix-test.stytrix-test.workers.dev/api/ws'

const open = (name) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(WS)
    ws.addEventListener('open', () => resolve(ws))
    ws.addEventListener('error', (e) => reject(new Error(`${name} ws error`)))
  })

const a = await open('A')
const b = await open('B')

const bMessages = []
b.addEventListener('message', (e) => bMessages.push(JSON.parse(e.data)))

await new Promise((r) => setTimeout(r, 500))

const nodeId = crypto.randomUUID()
a.send(JSON.stringify({
  type: 'create',
  node: { id: nodeId, type: 'rect', x: 100, y: 100, w: 160, h: 100, content: '', fill: '#ffd6d6' },
}))
await new Promise((r) => setTimeout(r, 800))
a.send(JSON.stringify({ type: 'move', id: nodeId, x: 300, y: 250, commit: true }))
a.send(JSON.stringify({ type: 'cursor', x: 50, y: 60 }))
await new Promise((r) => setTimeout(r, 800))

const gotCreate = bMessages.find((m) => m.type === 'create' && m.node?.id === nodeId)
const gotMove = bMessages.find((m) => m.type === 'move' && m.id === nodeId && m.x === 300)
const gotCursor = bMessages.find((m) => m.type === 'cursor')

console.log('B received create:', !!gotCreate, gotCreate ? `(created_by=${gotCreate.node.created_by})` : '')
console.log('B received move:', !!gotMove)
console.log('B received cursor:', !!gotCursor, gotCursor ? `(name=${gotCursor.name})` : '')

const rows = await fetch(`${BASE}/api/nodes`).then((r) => r.json())
const persisted = rows.find((n) => n.id === nodeId)
console.log('D1 persisted:', !!persisted, persisted ? `(x=${persisted.x}, y=${persisted.y})` : '')

// cleanup 測試節點
a.send(JSON.stringify({ type: 'delete', id: nodeId }))
await new Promise((r) => setTimeout(r, 500))
const after = await fetch(`${BASE}/api/nodes`).then((r) => r.json())
console.log('cleanup ok:', !after.find((n) => n.id === nodeId))

a.close(); b.close()
