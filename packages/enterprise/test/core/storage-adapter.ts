import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll } from "bun:test"
import { Storage } from "../../src/core/storage"

/** Minimal in-memory Adapter so the enterprise core tests run without cloud credentials. */
export function memoryAdapter() {
  const objects = new Map<string, string>()
  const keys = () => [...objects.keys()].sort()
  return {
    async read(path: string) {
      return objects.get(path)
    },
    async write(path: string, value: string) {
      objects.set(path, value)
    },
    async remove(path: string) {
      objects.delete(path)
    },
    async list(options?: { prefix?: string; limit?: number; after?: string; before?: string }) {
      const prefix = options?.prefix ?? ""
      const after = options?.after === undefined ? undefined : prefix + options.after + ".json"
      const before = options?.before === undefined ? undefined : prefix + options.before + ".json"
      const matched = keys().filter(
        (key) =>
          key.startsWith(prefix) && (after === undefined || key > after) && (before === undefined || key < before),
      )
      return options?.limit === undefined ? matched : matched.slice(0, options.limit)
    },
  }
}

/**
 * Installs an in-memory adapter for the suite and restores the previous one afterwards.
 *
 * `Storage` resolves its adapter lazily and memoizes it, so a process keeps whatever adapter was
 * first resolved. Each suite owns a fresh adapter and `afterAll` puts the previous one back.
 */
export function useMemoryStorage() {
  const previous = Storage.useAdapter(memoryAdapter())
  afterAll(() => {
    Storage.useAdapter(previous)
  })
}

/** Creates a temporary directory removed when the process ends, mirroring session filesystem tests. */
export function useTempDirectory(prefix: string) {
  const directories: string[] = []
  afterAll(async () => {
    await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })))
  })
  return async () => {
    const directory = await mkdtemp(join(tmpdir(), prefix))
    directories.push(directory)
    return directory
  }
}
