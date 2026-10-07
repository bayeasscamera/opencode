import { expect, test } from "bun:test"

// The desktop main process runs on Node's built-in SQLite, which Bun does not provide (verified on
// 1.3.14). The store is imported lazily and the assertion only runs where the module exists, so the
// suite stays runnable here instead of dying on an unresolvable import.
const hasNodeSqlite = await import("node:sqlite").then(
  () => true,
  () => false,
)

test.skipIf(!hasNodeSqlite)("flushes the latest buffered draft and stores blobs", async () => {
  const { createDesktopDraftStore } = await import("./draft-store")
  const store = createDesktopDraftStore(":memory:")
  store.set("prompt", "first")
  store.set("prompt", "latest")
  expect(store.get("prompt")).toBe("latest")
  store.flush()
  expect(store.get("prompt")).toBe("latest")

  const bytes = new TextEncoder().encode("image")
  const id = store.putBlob(bytes)
  expect(store.getBlob(id)).toEqual(bytes)
  store.close()
})
