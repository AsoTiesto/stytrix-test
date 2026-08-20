// Cloudflare Worker: API + WebSocket 即時同步 (Durable Object) + D1 + R2 + Google OAuth

type Env = {
  DB: any
  FILES: any
  ROOM: any
  ASSETS: any
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
}

type SessionUser = { sub: string; name: string; email: string; picture?: string }

// ---------- cookie session (HMAC-signed) ----------

const enc = new TextEncoder()

async function hmacKey(secret: string) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ])
}

function b64url(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function b64urlDecode(s: string): Uint8Array {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(pad + '='.repeat((4 - (pad.length % 4)) % 4))
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}

async function signSession(user: SessionUser, secret: string): Promise<string> {
  const payload = b64url(enc.encode(JSON.stringify(user)))
  const key = await hmacKey(secret)
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload))
  return `${payload}.${b64url(sig)}`
}

async function verifySession(token: string, secret: string): Promise<SessionUser | null> {
  const [payload, sig] = token.split('.')
  if (!payload || !sig) return null
  const key = await hmacKey(secret)
  const ok = await crypto.subtle.verify('HMAC', key, b64urlDecode(sig) as any, enc.encode(payload))
  if (!ok) return null
  try {
    return JSON.parse(new TextDecoder().decode(b64urlDecode(payload)))
  } catch {
    return null
  }
}

function getCookie(req: Request, name: string): string | null {
  const h = req.headers.get('Cookie') || ''
  const m = h.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`))
  return m ? m[1] : null
}

async function getUser(req: Request, env: Env): Promise<SessionUser | null> {
  if (!env.GOOGLE_CLIENT_SECRET) return null
  const token = getCookie(req, 'session')
  if (!token) return null
  return verifySession(token, env.GOOGLE_CLIENT_SECRET)
}

// ---------- main worker ----------

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    const path = url.pathname

    // WebSocket → Durable Object（單一共享房間 main）
    if (path === '/api/ws') {
      const user = await getUser(req, env)
      const id = env.ROOM.idFromName('main')
      const headers = new Headers(req.headers)
      headers.set('x-user-name', encodeURIComponent(user?.name || ''))
      headers.set('x-user-sub', user?.sub || '')
      return env.ROOM.get(id).fetch(new Request(req.url, { headers }))
    }

    if (path === '/api/nodes' && req.method === 'GET') {
      const { results } = await env.DB.prepare('SELECT * FROM nodes ORDER BY created_at ASC').all()
      return json(results)
    }

    if (path === '/api/me') {
      const user = await getUser(req, env)
      return user ? json(user) : json(null, 401)
    }

    if (path === '/api/auth/login') {
      if (!env.GOOGLE_CLIENT_ID) return json({ error: 'GOOGLE_CLIENT_ID not configured' }, 500)
      const redirect = `${url.origin}/api/auth/callback`
      const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth')
      auth.searchParams.set('client_id', env.GOOGLE_CLIENT_ID)
      auth.searchParams.set('redirect_uri', redirect)
      auth.searchParams.set('response_type', 'code')
      auth.searchParams.set('scope', 'openid profile email')
      return Response.redirect(auth.toString(), 302)
    }

    if (path === '/api/auth/callback') {
      const code = url.searchParams.get('code')
      if (!code || !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return json({ error: 'bad request' }, 400)
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: env.GOOGLE_CLIENT_ID,
          client_secret: env.GOOGLE_CLIENT_SECRET,
          redirect_uri: `${url.origin}/api/auth/callback`,
          grant_type: 'authorization_code',
        }),
      })
      const tokens: any = await tokenRes.json()
      if (!tokens.id_token) return json({ error: 'token exchange failed', detail: tokens }, 400)
      // id_token 直接來自 Google 的 token endpoint（TLS），取 payload 即可
      const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(tokens.id_token.split('.')[1])))
      const user: SessionUser = {
        sub: payload.sub,
        name: payload.name || payload.email,
        email: payload.email,
        picture: payload.picture,
      }
      const session = await signSession(user, env.GOOGLE_CLIENT_SECRET)
      return new Response(null, {
        status: 302,
        headers: {
          Location: '/',
          'Set-Cookie': `session=${session}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`,
        },
      })
    }

    if (path === '/api/auth/logout') {
      return new Response(null, {
        status: 302,
        headers: { Location: '/', 'Set-Cookie': 'session=; Path=/; Max-Age=0' },
      })
    }

    if (path === '/api/upload' && req.method === 'POST') {
      const key = `img/${crypto.randomUUID()}`
      await env.FILES.put(key, req.body, {
        httpMetadata: { contentType: req.headers.get('Content-Type') || 'application/octet-stream' },
      })
      return json({ key })
    }

    if (path.startsWith('/api/files/') && req.method === 'GET') {
      const key = decodeURIComponent(path.slice('/api/files/'.length))
      const obj = await env.FILES.get(key)
      if (!obj) return new Response('not found', { status: 404 })
      return new Response(obj.body, {
        headers: {
          'Content-Type': obj.httpMetadata?.contentType || 'application/octet-stream',
          'Cache-Control': 'public, max-age=31536000, immutable',
        },
      })
    }

    return new Response('not found', { status: 404 })
  },
}

// ---------- Durable Object: 即時協作房間 ----------

type WsMeta = { clientId: string; name: string; sub: string; color: string }

const COLORS = ['#e5484d', '#f76b15', '#ffc53d', '#30a46c', '#0090ff', '#8e4ec6', '#e93d82']

export class CanvasRoom {
  ctx: any
  env: Env

  constructor(ctx: any, env: Env) {
    this.ctx = ctx
    this.env = env
  }

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 })
    const pair = new (globalThis as any).WebSocketPair()
    const [client, server] = [pair[0], pair[1]]
    const meta: WsMeta = {
      clientId: crypto.randomUUID(),
      name: decodeURIComponent(req.headers.get('x-user-name') || '') || '訪客',
      sub: req.headers.get('x-user-sub') || '',
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
    }
    this.ctx.acceptWebSocket(server)
    server.serializeAttachment(meta)
    server.send(JSON.stringify({ type: 'hello', clientId: meta.clientId, name: meta.name, color: meta.color }))
    return new Response(null, { status: 101, webSocket: client })
  }

  broadcast(sender: any, msg: unknown) {
    const data = JSON.stringify(msg)
    for (const ws of this.ctx.getWebSockets()) {
      if (ws !== sender) {
        try {
          ws.send(data)
        } catch {}
      }
    }
  }

  async webSocketMessage(ws: any, raw: string | ArrayBuffer) {
    if (typeof raw !== 'string') return
    let msg: any
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }
    const meta: WsMeta = ws.deserializeAttachment()
    const db = this.env.DB

    switch (msg.type) {
      case 'create': {
        const n = msg.node
        await db
          .prepare(
            'INSERT INTO nodes (id, type, x, y, w, h, content, fill, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)'
          )
          .bind(n.id, n.type, n.x, n.y, n.w, n.h, n.content || '', n.fill || '', meta.name, Date.now())
          .run()
        this.broadcast(ws, { type: 'create', node: { ...n, created_by: meta.name } })
        break
      }
      case 'move': {
        // 拖曳過程即時廣播；commit=true 時才寫進 D1
        this.broadcast(ws, { type: 'move', id: msg.id, x: msg.x, y: msg.y })
        if (msg.commit) {
          await db.prepare('UPDATE nodes SET x = ?, y = ? WHERE id = ?').bind(msg.x, msg.y, msg.id).run()
        }
        break
      }
      case 'update': {
        await db.prepare('UPDATE nodes SET content = ? WHERE id = ?').bind(msg.content, msg.id).run()
        this.broadcast(ws, { type: 'update', id: msg.id, content: msg.content })
        break
      }
      case 'delete': {
        await db.prepare('DELETE FROM nodes WHERE id = ?').bind(msg.id).run()
        this.broadcast(ws, { type: 'delete', id: msg.id })
        break
      }
      case 'cursor': {
        this.broadcast(ws, {
          type: 'cursor',
          clientId: meta.clientId,
          name: meta.name,
          color: meta.color,
          x: msg.x,
          y: msg.y,
        })
        break
      }
    }
  }

  async webSocketClose(ws: any) {
    const meta: WsMeta = ws.deserializeAttachment()
    this.broadcast(ws, { type: 'leave', clientId: meta.clientId })
  }
}
