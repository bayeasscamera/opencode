import { usePlatform } from "@/context/platform"
import { ServerConnection } from "@/context/server"
import { authTokenFromCredentials, createSdkForServer } from "./server"
import { ClientError, OpenCode } from "@opencode-ai/client"
import { makeEventListener } from "@solid-primitives/event-listener"
import { Accessor, createEffect, onCleanup } from "solid-js"
import { createStore, reconcile } from "solid-js/store"

export type ServerHealth = { healthy: boolean; version?: string }

interface CheckServerHealthOptions {
  timeoutMs?: number
  signal?: AbortSignal
  retryCount?: number
  retryDelayMs?: number
}

const defaultTimeoutMs = 30_000
const defaultRetryCount = 2
// Backoff between retries of an unreachable server. The previous flat 100ms meant a burst of three
// requests 100ms apart, which hammers a server that is merely still starting. Backing off keeps the
// total retry window (~1.4s) far below the poll interval and the 30s request timeout.
const retryDelayMs = (attempt: number) => 200 * 2 ** attempt
const cacheMs = 750
const healthCache = new Map<
  string,
  { at: number; done: boolean; fetch: typeof globalThis.fetch; promise: Promise<ServerHealth> }
>()

function cacheKey(server: ServerConnection.HttpBase) {
  return `${server.url}\n${server.username ?? ""}\n${server.password ?? ""}`
}

function timeoutSignal(timeoutMs: number) {
  const timeout = (AbortSignal as unknown as { timeout?: (ms: number) => AbortSignal }).timeout
  if (timeout) {
    try {
      return {
        signal: timeout.call(AbortSignal, timeoutMs),
        clear: undefined as (() => void) | undefined,
      }
    } catch {}
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  return { signal: controller.signal, clear: () => clearTimeout(timer) }
}

function wait(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException("Aborted", "AbortError"))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

function retryable(error: unknown, signal?: AbortSignal) {
  if (signal?.aborted) return false
  if (error instanceof ClientError) return error.reason === "Transport"
  if (!(error instanceof Error)) return false
  if (error.name === "AbortError" || error.name === "TimeoutError") return false
  if (error instanceof TypeError) return true
  return /network|fetch|econnreset|econnrefused|enotfound|timedout/i.test(error.message)
}

export async function checkServerHealth(
  server: ServerConnection.HttpBase,
  fetch: typeof globalThis.fetch,
  opts?: CheckServerHealthOptions,
): Promise<ServerHealth> {
  const timeout = opts?.signal ? undefined : timeoutSignal(opts?.timeoutMs ?? defaultTimeoutMs)
  const signal = opts?.signal ?? timeout?.signal
  const retryCount = opts?.retryCount ?? defaultRetryCount
  const delayFor = (attempt: number) => opts?.retryDelayMs ?? retryDelayMs(attempt)
  const next = (count: number, error: unknown) => {
    if (count >= retryCount || !retryable(error, signal)) return Promise.resolve({ healthy: false } as const)
    return wait(delayFor(count), signal)
      .then(() => attempt(count + 1))
      .catch(() => ({ healthy: false }))
  }
  const attempt = async (count: number): Promise<ServerHealth> => {
    const current = await OpenCode.make({
      baseUrl: server.url,
      fetch,
      headers: server.password
        ? {
            Authorization: `Basic ${authTokenFromCredentials({ username: server.username, password: server.password })}`,
          }
        : undefined,
    })
      .health.get({ signal })
      .then((x) =>
        typeof x.healthy === "boolean"
          ? { data: { healthy: x.healthy, version: x.version } }
          : { error: new Error("Invalid health response") },
      )
      .catch((error) => ({ error }))
    if ("data" in current && current.data) return current.data
    if (signal?.aborted) return { healthy: false }

    return createSdkForServer({ server, fetch, signal })
      .global.health()
      .then((x) => (x.error ? next(count, x.error) : { healthy: x.data?.healthy === true, version: x.data?.version }))
      .catch((error) => next(count, error))
  }
  return attempt(0).finally(() => timeout?.clear?.())
}

// The polling interval must exceed the worst-case single check. `checkServerHealth` allows 30s by
// default (defaultTimeoutMs) and can retry twice, so a 10s interval guaranteed overlapping ticks:
// against an unreachable server every tick started a new 30s request while the previous ones were
// still in flight. 45s keeps the cadence below that worst case while still refreshing quickly in
// the normal, fast case.
const pollMs = 45_000

/** Cap on distinct server entries kept in `healthCache`; entries are removed as they are seen. */
const healthCacheMaxEntries = 8

export function useCheckServerHealth() {
  const platform = usePlatform()
  const fetcher = platform.fetch ?? globalThis.fetch

  return (http: ServerConnection.HttpBase) => {
    const key = cacheKey(http)
    const hit = healthCache.get(key)
    const now = Date.now()
    if (hit && hit.fetch === fetcher && (!hit.done || now - hit.at < cacheMs)) return hit.promise
    const promise = checkServerHealth(http, fetcher).finally(() => {
      const next = healthCache.get(key)
      if (!next || next.promise !== promise) return
      next.done = true
      next.at = Date.now()
    })
    healthCache.set(key, { at: now, done: false, fetch: fetcher, promise })
    // The cache key includes the server URL and credentials, so it grows with every distinct server
    // the user has ever polled. Re-inserting the key moves it to the end of the Map's iteration
    // order, which makes the oldest entry the first one seen here.
    if (healthCache.size > healthCacheMaxEntries) {
      for (const oldest of healthCache.keys()) {
        if (oldest === key) break
        healthCache.delete(oldest)
        break
      }
    }
    return promise
  }
}

export const useServerHealth = (servers: Accessor<ServerConnection.Any[]>, enabled: Accessor<boolean>) => {
  const checkServerHealth = useCheckServerHealth()
  const [status, setStatus] = createStore({} as Record<ServerConnection.Key, ServerHealth | undefined>)

  createEffect(() => {
    if (!enabled()) {
      setStatus(reconcile({}))
      return
    }
    const list = servers()
    let dead = false
    let running = false

    const refresh = async () => {
      // Re-entrancy guard. A check may legitimately last up to 30s (defaultTimeoutMs) plus retries,
      // so a tick can still arrive before the previous pass settled. Without this guard each tick
      // would stack another full set of requests on an unreachable server.
      if (running) return
      running = true
      try {
        const results: Record<string, ServerHealth> = {}
        await Promise.all(
          list.map(async (conn) => {
            const key = ServerConnection.key(conn)
            const result = await checkServerHealth(conn.http)
            results[key] = result
            if (!dead) setStatus(key, result)
          }),
        )
        if (dead) return
        setStatus(reconcile(results))
      } finally {
        running = false
      }
    }

    // Nothing on screen consumes the health result while the window is hidden, so a background
    // window only polls when it becomes visible again. Returning to the foreground refreshes
    // immediately, which also makes the indicator correct as soon as the window is shown.
    const tick = () => {
      if (document.visibilityState !== "visible") return
      void refresh()
    }

    void refresh()
    const id = setInterval(tick, pollMs)
    makeEventListener(document, "visibilitychange", tick)

    onCleanup(() => {
      dead = true
      clearInterval(id)
    })
  })

  return status
}
