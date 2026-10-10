import { createServer } from 'node:http'
import { gunzipSync, gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { forward, upstreamUrl, wsOriginOf } from './routing.js'

const APP = 'https://narrative.example.com'
const UP = 'http://caddy'

describe('upstreamUrl', () => {
  it('moves a request on the app origin to the upstream, path and query kept', () => {
    expect(upstreamUrl(`${APP}/deck/d1/render?slide=2&share_token=t`, APP, UP)).toBe(
      'http://caddy/deck/d1/render?slide=2&share_token=t',
    )
    expect(upstreamUrl(`${APP}/storage/narrative-media/a.png?X-Amz-Signature=s`, APP, UP)).toBe(
      'http://caddy/storage/narrative-media/a.png?X-Amz-Signature=s',
    )
  })

  it("moves the page's WebSocket to the upstream's ws: form", () => {
    expect(upstreamUrl('wss://narrative.example.com/ws?share_token=t', wsOriginOf(APP), UP)).toBe(
      'ws://caddy/ws?share_token=t',
    )
  })

  it('leaves any other origin alone', () => {
    expect(upstreamUrl('https://other.example.com/x', APP, UP)).toBeNull()
    expect(upstreamUrl('http://narrative.example.com/x', APP, UP)).toBeNull()
  })
})

describe('wsOriginOf', () => {
  it('maps https to wss and http to ws', () => {
    expect(wsOriginOf(APP)).toBe('wss://narrative.example.com')
    expect(wsOriginOf('http://localhost:5173')).toBe('ws://localhost:5173')
  })
})

describe('forward', () => {
  it('sends the original Host to the upstream and passes the response through as it came', async () => {
    let seenHost = ''
    let seenBody = ''
    const server = createServer((req, res) => {
      seenHost = req.headers.host ?? ''
      let body = ''
      req.on('data', (c: Buffer) => (body += c.toString()))
      req.on('end', () => {
        seenBody = body
        res.writeHead(201, { 'content-encoding': 'gzip', 'content-type': 'text/plain' })
        res.end(gzipSync('hello'))
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const { port } = server.address() as { port: number }
    try {
      const out = await forward(`http://127.0.0.1:${port}/api/x?q=1`, {
        method: 'POST',
        headers: { host: 'narrative.example.com', 'content-type': 'text/plain' },
        body: Buffer.from('ping'),
      })
      expect(seenHost).toBe('narrative.example.com')
      expect(seenBody).toBe('ping')
      expect(out.status).toBe(201)
      expect(out.headers['content-encoding']).toBe('gzip')
      expect(gunzipSync(out.body).toString()).toBe('hello')
    } finally {
      server.close()
    }
  })
})
