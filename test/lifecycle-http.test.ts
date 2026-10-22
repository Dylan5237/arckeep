import { createServer, type Server } from 'node:http'
import type { Socket } from 'node:net'
import { describe, expect, it } from 'vitest'
import { readHttpResponse } from '../src/github/http-request.js'
import { TaskScope, withDeadline } from '../src/shared/task-scope.js'

async function listen(server: Server): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Local test server did not bind')
  return `http://127.0.0.1:${address.port}`
}

async function stop(server: Server): Promise<void> {
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}

describe('native HTTP lifecycle boundary', () => {
  it('cancels a real hanging response body and closes its socket before draining', async () => {
    let markStarted!: () => void
    const started = new Promise<void>(resolve => { markStarted = resolve })
    let markClosed!: () => void
    const closed = new Promise<void>(resolve => { markClosed = resolve })
    const server = createServer((request, response) => {
      request.socket.once('close', markClosed)
      response.writeHead(200, { 'Content-Type': 'text/plain' })
      response.write('partial body')
      markStarted()
    })
    const url = await listen(server)
    const scope = new TaskScope()
    const operation = scope.run(signal => readHttpResponse(url, {}, fetch, { signal }))
    const cancelled = expect(operation).rejects.toMatchObject({ name: 'AbortError' })
    try {
      await withDeadline(started, 3000, 'Test request did not arrive')
      scope.close()
      await cancelled
      await scope.drain()
      await withDeadline(closed, 3000, 'Cancelled request socket remained open')
      expect(scope.pendingCount).toBe(0)
    } finally {
      scope.close()
      await scope.drain().catch(() => {})
      await stop(server)
    }
  }, 10_000)

  it('times out a real request that never returns headers and closes its socket', async () => {
    const sockets = new Set<Socket>()
    let markClosed!: () => void
    const closed = new Promise<void>(resolve => { markClosed = resolve })
    const server = createServer(() => {})
    server.on('connection', socket => {
      sockets.add(socket)
      socket.once('close', () => { sockets.delete(socket); markClosed() })
    })
    const url = await listen(server)
    try {
      await expect(readHttpResponse(url, {}, fetch, { timeoutMs: 1000 }))
        .rejects.toMatchObject({ name: 'TimeoutError' })
      await withDeadline(closed, 3000, 'Timed-out request socket remained open')
      expect(sockets.size).toBe(0)
    } finally {
      await stop(server)
    }
  }, 10_000)
})
