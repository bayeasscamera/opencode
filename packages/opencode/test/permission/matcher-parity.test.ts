import { describe, expect, test } from "bun:test"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { Permission } from "../../src/permission"

/**
 * The legacy evaluator (`@/permission`, "V1") and the current one (`@opencode-ai/core/permission`,
 * "V2") both match a rule with the same shared `Wildcard` helper and the same `findLast` +
 * "default to ask" policy. Merging them is tracked by specs/v2/permission-merge.md, and this suite is
 * the safety net for the part that must not move: the matcher decision.
 *
 * Each case is written once in a neutral vocabulary and translated into both rule shapes, so a
 * divergence in the matching semantics fails here instead of surfacing as a permission prompt that
 * appears (or not) in production.
 */

type Effect = "allow" | "ask" | "deny"
type NeutralRule = { action: string; resource: string; effect: Effect }

const v2Rules = (rules: readonly NeutralRule[]) =>
  rules.map((rule) => ({ action: rule.action, resource: rule.resource, effect: rule.effect }))
const v1Rules = (rules: readonly NeutralRule[]) =>
  rules.map((rule) => ({ permission: rule.action, pattern: rule.resource, action: rule.effect }))

const cases: ReadonlyArray<{ name: string; action: string; resource: string; rules: NeutralRule[] }> = [
  { name: "no rules falls back to ask", action: "bash", resource: "rm -rf /", rules: [] },
  { name: "exact allow", action: "bash", resource: "ls", rules: [{ action: "bash", resource: "ls", effect: "allow" }] },
  {
    name: "exact deny",
    action: "bash",
    resource: "rm -rf /",
    rules: [{ action: "bash", resource: "rm -rf /", effect: "deny" }],
  },
  {
    name: "unmatched resource falls back to ask",
    action: "bash",
    resource: "ls",
    rules: [{ action: "bash", resource: "rm *", effect: "deny" }],
  },
  { name: "wildcard action", action: "bash", resource: "ls", rules: [{ action: "*", resource: "*", effect: "deny" }] },
  {
    name: "wildcard resource",
    action: "edit",
    resource: "/tmp/a.ts",
    rules: [{ action: "edit", resource: "*", effect: "allow" }],
  },
  {
    name: "prefix wildcard",
    action: "edit",
    resource: "/src/a.ts",
    rules: [{ action: "edit", resource: "/src/*", effect: "allow" }],
  },
  {
    name: "later rule wins across one ruleset",
    action: "bash",
    resource: "ls",
    rules: [
      { action: "bash", resource: "ls", effect: "deny" },
      { action: "bash", resource: "ls", effect: "allow" },
    ],
  },
  {
    name: "earlier win is not kept when a later rule matches",
    action: "bash",
    resource: "ls",
    rules: [
      { action: "bash", resource: "ls", effect: "allow" },
      { action: "bash", resource: "ls", effect: "deny" },
    ],
  },
  {
    name: "a broad later rule overrides a specific earlier one",
    action: "bash",
    resource: "ls",
    rules: [
      { action: "bash", resource: "ls", effect: "deny" },
      { action: "*", resource: "*", effect: "allow" },
    ],
  },
  {
    name: "backslashes normalise like slashes",
    action: "edit",
    resource: "C:\\src\\a.ts",
    rules: [{ action: "edit", resource: "C:/src/*", effect: "allow" }],
  },
  {
    name: "case sensitivity is preserved",
    action: "Bash",
    resource: "ls",
    rules: [{ action: "bash", resource: "ls", effect: "allow" }],
  },
]

describe("permission matcher parity between V1 and V2", () => {
  for (const entry of cases) {
    test(entry.name, () => {
      const v2 = PermissionV2.evaluate(entry.action, entry.resource, v2Rules(entry.rules))
      const v1 = Permission.evaluate(entry.action, entry.resource, v1Rules(entry.rules))
      expect(v1.action).toBe(v2.effect)
    })
  }

  test("multiple rulesets are flattened in the same order", () => {
    const first: NeutralRule[] = [{ action: "*", resource: "*", effect: "deny" }]
    const second: NeutralRule[] = [{ action: "bash", resource: "ls", effect: "allow" }]

    const v2 = PermissionV2.evaluate("bash", "ls", v2Rules(first), v2Rules(second))
    const v1 = Permission.evaluate("bash", "ls", v1Rules(first), v1Rules(second))

    expect(v1.action).toBe("allow")
    expect(v1.action).toBe(v2.effect)
  })
})
