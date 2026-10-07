#!/usr/bin/env bun

/**
 * Prints the current-runtime versus legacy-runtime inventory used by
 * specs/v2/legacy-decommission.md.
 *
 * `packages/core` is the current runtime and `packages/opencode` still carries the legacy one. The
 * retirement plan is tracked per domain, so this tool measures the overlap instead of leaving it to
 * a hand-written table that drifts. Run it when the numbers below a milestone change:
 *
 *   bun run architecture:inventory
 */

import { Glob } from "bun"
import { join } from "node:path"

const root = new URL("..", import.meta.url).pathname
const trees = {
  current: join(root, "packages/core/src"),
  legacy: join(root, "packages/opencode/src"),
} as const

const domain = (file: string) => (file.includes("/") ? file.slice(0, file.indexOf("/")) : "(top level)")

async function measure(dir: string) {
  const files = ["**/*.ts", "**/*.tsx"].flatMap((pattern) => [...new Glob(pattern).scanSync(dir)])
  const measured = await Promise.all(
    files.map(async (file) => ({
      domain: domain(file),
      lines: (await Bun.file(join(dir, file)).text()).split("\n").length,
    })),
  )
  const perDomain = measured.reduce((totals, entry) => {
    totals.set(entry.domain, (totals.get(entry.domain) ?? 0) + entry.lines)
    return totals
  }, new Map<string, number>())
  return { files: files.length, lines: measured.reduce((sum, entry) => sum + entry.lines, 0), perDomain }
}

const current = await measure(trees.current)
const legacy = await measure(trees.legacy)

const shared = [...current.perDomain.keys()].filter((name) => legacy.perDomain.has(name)).sort()
const width = Math.max(...shared.map((name) => name.length), "domain".length)

console.log(`current (packages/core/src)     : ${current.files} files, ${current.lines} lines`)
console.log(`legacy  (packages/opencode/src) : ${legacy.files} files, ${legacy.lines} lines`)
console.log()
console.log(`${"domain".padEnd(width)}  ${"current".padStart(8)}  ${"legacy".padStart(8)}`)
console.log(`${"-".repeat(width)}  ${"-".repeat(8)}  ${"-".repeat(8)}`)
for (const name of shared.sort((a, b) => legacy.perDomain.get(b)! - legacy.perDomain.get(a)!)) {
  const left = current.perDomain.get(name) ?? 0
  const right = legacy.perDomain.get(name) ?? 0
  console.log(`${name.padEnd(width)}  ${String(left).padStart(8)}  ${String(right).padStart(8)}`)
}
console.log()
console.log(`domains present in both trees: ${shared.length}`)
console.log(
  `lines in shared domains: ${shared.reduce((sum, name) => sum + (current.perDomain.get(name) ?? 0) + (legacy.perDomain.get(name) ?? 0), 0)}`,
)
