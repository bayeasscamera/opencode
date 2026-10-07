import { expect, test } from "bun:test"
import { dirname, join, resolve } from "node:path"

// Packages that make up the current runtime and its clients. `packages/opencode` is the assembly
// point: it may depend on all of them, but none of them may reach back into it, and the legacy
// runtime must not grow new consumers. See specs/v2/legacy-decommission.md (M1).
const CURRENT_PACKAGES = [
  "app",
  "cli",
  "client",
  "core",
  "llm",
  "plugin",
  "protocol",
  "schema",
  "server",
  "session-ui",
  "tui",
  "ui",
] as const

// Runtime dependency direction from AGENTS.md: "Keep runtime dependencies directed from Schema to
// Core and Protocol, then from Core and Protocol to Server. Client runtime code may depend on
// Schema and Protocol but never Core or Server." Expressed as forbidden edges so a new package does
// not need an entry here, and so a devDependency (build-time tooling) stays allowed.
const FORBIDDEN_RUNTIME_DEPENDENCIES: Record<string, readonly string[]> = {
  client: ["core", "llm", "opencode", "plugin", "server", "ui"],
  core: ["client", "opencode", "protocol", "server", "ui"],
  llm: ["client", "core", "opencode", "plugin", "protocol", "server", "ui"],
  protocol: ["client", "core", "llm", "opencode", "plugin", "server", "ui"],
  schema: ["client", "core", "llm", "opencode", "plugin", "protocol", "server", "ui"],
  server: ["client", "llm", "opencode", "plugin", "ui"],
}

const packagesRoot = new URL("../../", import.meta.url).pathname

async function sourceFiles(pkg: string) {
  const root = join(packagesRoot, pkg, "src")
  const found = ["**/*.ts", "**/*.tsx"].flatMap((pattern) => [...new Bun.Glob(pattern).scanSync(root)])
  return await Promise.all(
    found.map(async (file) => ({
      file: join(pkg, "src", file),
      source: await Bun.file(join(root, file)).text(),
    })),
  )
}

const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']([^"']+)["']/g

function specifiers(source: string) {
  return [...source.matchAll(SPECIFIER)].map((match) => match[1])
}

/** True when an import specifier resolves into `packages/opencode`, however it is written. */
function reachesLegacyRuntime(file: string, specifier: string) {
  if (specifier === "@opencode-ai/opencode" || specifier.startsWith("@opencode-ai/opencode/")) return true
  if (!specifier.startsWith(".")) return false
  const legacy = resolve(packagesRoot, "opencode")
  const target = resolve(packagesRoot, dirname(file), specifier)
  return target === legacy || target.startsWith(legacy + "/")
}

async function runtimeDependencies(pkg: string) {
  const manifest: unknown = await Bun.file(join(packagesRoot, pkg, "package.json")).json()
  if (typeof manifest !== "object" || manifest === null) return []
  const dependencies = Object.getOwnPropertyDescriptor(manifest, "dependencies")?.value
  if (typeof dependencies !== "object" || dependencies === null) return []
  return Object.keys(dependencies)
}

test("current packages do not import the legacy runtime", async () => {
  const files = (await Promise.all(CURRENT_PACKAGES.map(sourceFiles))).flat()
  // Guard against a broken glob quietly turning this test into a no-op.
  expect(files.length).toBeGreaterThan(500)

  const violations = files.flatMap(({ file, source }) =>
    specifiers(source)
      .filter((specifier) => reachesLegacyRuntime(file, specifier))
      .map((specifier) => `${file} -> ${specifier}`),
  )

  expect(violations).toEqual([])
})

test("current packages declare no runtime dependency on the legacy runtime", async () => {
  const violations = await Promise.all(
    CURRENT_PACKAGES.map(async (pkg) =>
      (await runtimeDependencies(pkg)).map((name) => ({ pkg, name })).filter(({ name }) => name.includes("opencode")),
    ),
  )

  expect(violations.flat().filter(({ name }) => name.replace("@opencode-ai/", "").startsWith("opencode"))).toEqual([])
})

test("runtime dependencies keep the documented direction", async () => {
  const violations = await Promise.all(
    Object.entries(FORBIDDEN_RUNTIME_DEPENDENCIES).map(async ([pkg, forbidden]) =>
      (await runtimeDependencies(pkg))
        .filter((name) => forbidden.includes(name.replace("@opencode-ai/", "")))
        .map((name) => `${pkg} -> ${name}`),
    ),
  )

  expect(violations.flat()).toEqual([])
})
