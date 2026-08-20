import { useCallback, useEffect, useRef, useState } from 'react'
import './App.css'

type NodeType = 'rect' | 'text' | 'image'

type CanvasNode = {
  id: string
  type: NodeType
  x: number
  y: number
  w: number
  h: number
  content: string
  fill: string
  created_by?: string
}

type User = { sub: string; name: string; email: string; picture?: string }

type RemoteCursor = { clientId: string; name: string; color: string; x: number; y: number }

const FILLS = ['#ffd6d6', '#ffe8cc', '#fff3bf', '#d3f9d8', '#d0ebff', '#e5dbff', '#ffdeeb']

function App() {
  const [nodes, setNodes] = useState<Record<string, CanvasNode>>({})
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [user, setUser] = useState<User | null>(null)
  const [cursors, setCursors] = useState<Record<string, RemoteCursor>>({})
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [connected, setConnected] = useState(false)

  const wsRef = useRef<WebSocket | null>(null)
  const offsetRef = useRef(offset)
  offsetRef.current = offset
  const dragRef = useRef<{
    mode: 'node' | 'pan'
    id?: string
    startX: number
    startY: number
    origX: number
    origY: number
  } | null>(null)
  const lastSentRef = useRef(0)

  // 初始載入：登入狀態 + D1 裡的節點
  useEffect(() => {
    fetch('/api/me').then(async (r) => setUser(r.ok ? await r.json() : null))
    fetch('/api/nodes')
      .then((r) => r.json())
      .then((rows: CanvasNode[]) => {
        const map: Record<string, CanvasNode> = {}
        for (const n of rows) map[n.id] = n
        setNodes(map)
      })
  }, [])

  // WebSocket 連線與自動重連
  useEffect(() => {
    let closed = false
    let ws: WebSocket

    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws'
      ws = new WebSocket(`${proto}://${location.host}/api/ws`)
      wsRef.current = ws
      ws.onopen = () => setConnected(true)
      ws.onclose = () => {
        setConnected(false)
        if (!closed) setTimeout(connect, 1000)
      }
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data)
        switch (msg.type) {
          case 'create':
            setNodes((prev) => ({ ...prev, [msg.node.id]: msg.node }))
            break
          case 'move':
            setNodes((prev) =>
              prev[msg.id] ? { ...prev, [msg.id]: { ...prev[msg.id], x: msg.x, y: msg.y } } : prev
            )
            break
          case 'update':
            setNodes((prev) =>
              prev[msg.id] ? { ...prev, [msg.id]: { ...prev[msg.id], content: msg.content } } : prev
            )
            break
          case 'delete':
            setNodes((prev) => {
              const next = { ...prev }
              delete next[msg.id]
              return next
            })
            break
          case 'cursor':
            setCursors((prev) => ({ ...prev, [msg.clientId]: msg }))
            break
          case 'leave':
            setCursors((prev) => {
              const next = { ...prev }
              delete next[msg.clientId]
              return next
            })
            break
        }
      }
    }
    connect()
    return () => {
      closed = true
      ws?.close()
    }
  }, [])

  const send = useCallback((msg: unknown) => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
  }, [])

  const addNode = (type: NodeType) => {
    const node: CanvasNode = {
      id: crypto.randomUUID(),
      type,
      x: -offsetRef.current.x + 120 + Math.random() * 300,
      y: -offsetRef.current.y + 120 + Math.random() * 200,
      w: type === 'text' ? 220 : 160,
      h: type === 'text' ? 48 : 100,
      content: type === 'text' ? '雙擊編輯文字' : '',
      fill: FILLS[Math.floor(Math.random() * FILLS.length)],
      created_by: user?.name || '訪客',
    }
    setNodes((prev) => ({ ...prev, [node.id]: node }))
    setSelectedId(node.id)
    send({ type: 'create', node })
  }

  const deleteSelected = useCallback(() => {
    if (!selectedId) return
    setNodes((prev) => {
      const next = { ...prev }
      delete next[selectedId]
      return next
    })
    send({ type: 'delete', id: selectedId })
    setSelectedId(null)
  }, [selectedId, send])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === 'Delete' || e.key === 'Backspace') && !editingId && selectedId) {
        e.preventDefault()
        deleteSelected()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [deleteSelected, editingId, selectedId])

  // 拖曳節點 / 平移畫布
  const onNodePointerDown = (e: React.PointerEvent, id: string) => {
    e.stopPropagation()
    if (editingId === id) return
    setSelectedId(id)
    const n = nodes[id]
    dragRef.current = { mode: 'node', id, startX: e.clientX, startY: e.clientY, origX: n.x, origY: n.y }
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }

  const onCanvasPointerDown = (e: React.PointerEvent) => {
    // 點空白處時若還在編輯文字，先把內容送出（textarea 被卸載時不會觸發 blur）
    if (editingId) commitText(editingId)
    setSelectedId(null)
    setEditingId(null)
    dragRef.current = {
      mode: 'pan',
      startX: e.clientX,
      startY: e.clientY,
      origX: offsetRef.current.x,
      origY: offsetRef.current.y,
    }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current
    const now = Date.now()

    // 廣播自己的游標位置（畫布座標）
    if (now - lastSentRef.current > 50) {
      send({ type: 'cursor', x: e.clientX - offsetRef.current.x, y: e.clientY - offsetRef.current.y })
      lastSentRef.current = now
    }

    if (!drag) return
    const dx = e.clientX - drag.startX
    const dy = e.clientY - drag.startY
    if (drag.mode === 'pan') {
      setOffset({ x: drag.origX + dx, y: drag.origY + dy })
    } else if (drag.id) {
      const x = drag.origX + dx
      const y = drag.origY + dy
      setNodes((prev) => ({ ...prev, [drag.id!]: { ...prev[drag.id!], x, y } }))
      send({ type: 'move', id: drag.id, x, y, commit: false })
    }
  }

  const onPointerUp = () => {
    const drag = dragRef.current
    if (drag?.mode === 'node' && drag.id) {
      const n = nodes[drag.id]
      if (n) send({ type: 'move', id: drag.id, x: n.x, y: n.y, commit: true })
    }
    dragRef.current = null
  }

  const onTextChange = (id: string, content: string) => {
    setNodes((prev) => ({ ...prev, [id]: { ...prev[id], content } }))
  }

  const commitText = (id: string) => {
    setEditingId(null)
    send({ type: 'update', id, content: nodes[id]?.content ?? '' })
  }

  // 拖圖片進畫布 → 上傳 R2 → 建立 image 節點
  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    const file = e.dataTransfer.files?.[0]
    if (!file || !file.type.startsWith('image/')) return
    const res = await fetch('/api/upload', {
      method: 'POST',
      headers: { 'Content-Type': file.type },
      body: file,
    })
    const { key } = await res.json()
    const node: CanvasNode = {
      id: crypto.randomUUID(),
      type: 'image',
      x: e.clientX - offsetRef.current.x - 100,
      y: e.clientY - offsetRef.current.y - 75,
      w: 200,
      h: 150,
      content: key,
      fill: '',
      created_by: user?.name || '訪客',
    }
    setNodes((prev) => ({ ...prev, [node.id]: node }))
    send({ type: 'create', node })
  }

  return (
    <div
      className="canvas-viewport"
      onPointerDown={onCanvasPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onDrop={onDrop}
      onDragOver={(e) => e.preventDefault()}
    >
      <div className="toolbar" onPointerDown={(e) => e.stopPropagation()}>
        <strong>Stytrix Canvas</strong>
        <button onClick={() => addNode('rect')}>+ 矩形</button>
        <button onClick={() => addNode('text')}>+ 文字</button>
        {selectedId && <button onClick={deleteSelected}>刪除</button>}
        <span className={connected ? 'dot on' : 'dot off'} title={connected ? '已連線' : '未連線'} />
        <span className="spacer" />
        {user ? (
          <span className="user">
            {user.picture && <img src={user.picture} alt="" referrerPolicy="no-referrer" />}
            {user.name}
            <a href="/api/auth/logout">登出</a>
          </span>
        ) : (
          <a className="login" href="/api/auth/login">
            使用 Google 登入
          </a>
        )}
      </div>

      <div className="canvas-layer" style={{ transform: `translate(${offset.x}px, ${offset.y}px)` }}>
        {Object.values(nodes).map((n) => (
          <div
            key={n.id}
            data-id={n.id}
            className={`node node-${n.type} ${selectedId === n.id ? 'selected' : ''}`}
            style={{
              left: n.x,
              top: n.y,
              width: n.w,
              height: n.h,
              background: n.type === 'rect' ? n.fill : undefined,
            }}
            title={n.created_by ? `建立者：${n.created_by}` : undefined}
            onPointerDown={(e) => onNodePointerDown(e, n.id)}
            onDoubleClick={() => n.type === 'text' && setEditingId(n.id)}
          >
            {n.type === 'text' &&
              (editingId === n.id ? (
                <textarea
                  autoFocus
                  value={n.content}
                  onChange={(e) => onTextChange(n.id, e.target.value)}
                  onBlur={() => commitText(n.id)}
                  onPointerDown={(e) => e.stopPropagation()}
                />
              ) : (
                <span>{n.content}</span>
              ))}
            {n.type === 'image' && (
              <img src={`/api/files/${encodeURIComponent(n.content)}`} alt="" draggable={false} />
            )}
          </div>
        ))}

        {Object.values(cursors).map((c) => (
          <div key={c.clientId} className="cursor" style={{ left: c.x, top: c.y, color: c.color }}>
            <svg width="16" height="16" viewBox="0 0 16 16">
              <path d="M0 0 L16 6 L7 8 L5 16 Z" fill="currentColor" />
            </svg>
            <label style={{ background: c.color }}>{c.name}</label>
          </div>
        ))}
      </div>

      <div className="hint">拖曳空白處平移畫布・拖圖片進來上傳・雙擊文字編輯</div>
    </div>
  )
}

export default App
