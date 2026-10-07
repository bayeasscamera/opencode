import { describe, expect, test } from "bun:test"
import { homedir } from "node:os"
import { Permission } from "../../src/permission"

/**
 * Characterizes the legacy config → rules translation (`Permission.fromConfig`).
 *
 * This is the behaviour `specs/v2/permission-merge.md` (M2) retires: it expands `~` and `$HOME`
 * unconditionally, **including for `bash`**, while the current runtime expands only path actions
 * (`packages/core/src/config/plugin/agent.ts:119-138` expands `external_directory`, `read` and
 * `edit`, and deliberately leaves shell text alone). Pinning the legacy contract here keeps that
 * difference measured instead of remembered, and makes an accidental change fail loudly.
 */
describe("legacy permission config translation", () => {
  test("a string value becomes a wildcard rule", () => {
    expect(Permission.fromConfig({ edit: "allow" })).toEqual([{ permission: "edit", pattern: "*", action: "allow" }])
  })

  test("map values become one rule per resource, preserving order", () => {
    expect(Permission.fromConfig({ bash: { ls: "allow", rm: "deny" } })).toEqual([
      { permission: "bash", pattern: "ls", action: "allow" },
      { permission: "bash", pattern: "rm", action: "deny" },
    ])
  })

  test("expands ~ and $HOME for a path action", () => {
    expect(Permission.fromConfig({ read: { "~/notes/*": "allow", "$HOME/secret/*": "deny", "~": "deny" } })).toEqual([
      { permission: "read", pattern: `${homedir()}/notes/*`, action: "allow" },
      { permission: "read", pattern: `${homedir()}/secret/*`, action: "deny" },
      { permission: "read", pattern: homedir(), action: "deny" },
    ])
  })

  test("also expands for bash, which the current runtime deliberately does not", () => {
    // The current runtime expands only external_directory/read/edit, because a bash resource is raw
    // shell text and rewriting it would need shell-aware parsing. See the design doc.
    expect(Permission.fromConfig({ bash: { "~/bin/*": "deny" } })).toEqual([
      { permission: "bash", pattern: `${homedir()}/bin/*`, action: "deny" },
    ])
  })

  test("merge flattens rulesets in order", () => {
    expect(
      Permission.merge(
        [{ permission: "a", pattern: "*", action: "allow" }],
        [{ permission: "b", pattern: "*", action: "deny" }],
      ),
    ).toEqual([
      { permission: "a", pattern: "*", action: "allow" },
      { permission: "b", pattern: "*", action: "deny" },
    ])
  })
})
