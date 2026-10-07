# Legacy Runtime Decommission

Status: **proposed** — the inventory below is measured, the milestones are not yet scheduled.
Owner: unassigned (see the per-domain column).
Related: `specs/v2/instructions.md`, `specs/v2/session.md`, `specs/v2/tools.md`, `AGENTS.md` §V2 Session Core.

## Why this document exists

`packages/core` is the current runtime. `packages/opencode` still contains a parallel legacy runtime that
predates it: two session stacks, two permission evaluators, two tool registries. Nothing in the
repository states which parts are still load-bearing or when the leftovers are deleted, so the two
copies drift and each behaviour has to be fixed twice.

The risk is not the duplicated lines themselves. It is that a rule changed in one evaluator silently
disagrees with the other, and that the next reader cannot tell which copy is authoritative.

## Rules

1. **One domain, one PR.** A domain is retired only by a pull request that migrates its last caller
   and deletes the legacy implementation in the same change. Partial migrations are what created the
   current state.
2. **No new imports from `packages/opencode/src` into current code.** New work depends on
   `@opencode-ai/core/*`; the legacy tree may keep importing outward while it is retired.
3. **The compatibility surface is explicit.** Anything intentionally kept for the App/TUI/CLI
   compatibility path (per `packages/schema/AGENTS.md`) is named `V1` and listed in the inventory
   rather than left implicit.
4. **A retired domain keeps its tests.** Deleting a legacy implementation must not delete coverage
   that the current implementation still needs; port the test first.

## Inventory

Measured with `find`/`grep` over `packages/core/src` and `packages/opencode/src` at commit
`ab936fb69f`. "Current refs" counts `@opencode-ai/core/<domain>` imports inside
`packages/opencode/src`; "legacy files" counts files under `packages/opencode/src/<domain>`.

| Domain        | Core LOC | Legacy LOC | Legacy files | Current refs | Status                                                      |
| ------------- | -------: | ---------: | -----------: | -----------: | ----------------------------------------------------------- |
| session       |     3730 |       8132 |           24 |           20 | Split: current V2 sessions exist, legacy loop still mounted |
| tool          |     4708 |       5301 |           27 |            0 | Split: two registries, legacy still primary for the CLI     |
| plugin        |     2957 |       6094 |           21 |            2 | Mostly legacy                                               |
| config        |      917 |       2082 |           15 |            1 | Split: V1 config parsed through `core/src/v1/config`        |
| project       |      536 |       1226 |            7 |           17 | Current mostly adopted                                      |
| permission    |       99 |        387 |            3 |            1 | Split: `PermissionV2` current, legacy evaluator still used  |
| control-plane |      168 |       1351 |            8 |            6 | Mostly legacy                                               |
| account       |       39 |        759 |            4 |            2 | Mostly legacy                                               |
| share         |       13 |        429 |            2 |            2 | Mostly legacy                                               |
| skill         |      289 |        494 |            2 |            1 | Current mostly adopted                                      |
| effect        |      500 |        768 |            — |            — | Infrastructure, tracked but low priority                    |
| id            |       47 |         80 |            — |            — | Trivial                                                     |
| image         |       94 |        172 |            — |            — | Low priority                                                |
| installation  |        8 |        336 |            — |            — | Low priority                                                |
| util          |     1070 |       1075 |            — |            — | Known duplicate helpers                                     |
| markdown.d.ts |        4 |          4 |            — |            — | Ambient declaration                                         |

Total measured overlap: **~15 179 lines** across the paired domains.

## Milestones

Each milestone is a checkpoint, not a schedule. A milestone closes when its exit criteria are met.

### M1 — Freeze the boundary

- [ ] CI fails on a new import edge from current code into `packages/opencode/src` (an
      `oxlint` restriction or an import-boundary test in `packages/core`).
- [ ] `packages/opencode/src/index.ts` documents which entrypoints still build the legacy runtime
      and why.
- [ ] This inventory is regenerated and re-committed when the numbers move.

### M2 — Unify permission (highest-value single merge)

Two evaluators exist: `packages/core/src/permission.ts` (current) and
`packages/opencode/src/permission/` (legacy). This is the divergence most likely to produce a
security-relevant disagreement.

- [ ] `packages/opencode/src/permission/index.ts` delegates to `PermissionV2` for every decision.
- [ ] `packages/opencode/src/permission/arity.ts` is either ported as typed schema data or deleted.
- [ ] `permission.v2.*` events become the only permission events the App/TUI consume.
- [ ] Exit: one evaluator, one event family, and the existing guard tests
      (`packages/core/test/tool-permission-guards.test.ts`,
      `packages/core/test/tool-permission-real.test.ts`) cover the merged path.

### M3 — Unify the tool registry

- [ ] `packages/core/src/tool/registry.ts` is the only registry; the legacy registry
      (`packages/opencode/src/tool/`) is reduced to adapters or deleted.
- [ ] The built-in guard coverage added on this branch (permission required for unguarded built-ins,
      `BashReadOnly`, `mod/` guards) is asserted against the unified registry.
- [ ] Exit: `ToolRegistry.whollyDisabled` and `PermissionV2.evaluate` are the only resolution
      paths, with their shared `findLast` semantics covered by a test.

### M4 — Retire the legacy session loop

- [ ] `packages/opencode/src/session/prompt.ts` (1631 lines) and its collaborators are removed
      once V2 exposes the operations the App/TUI still request.
- [ ] The unchecked items in `packages/core/src/session/runner/llm.ts` (header comment) are either
      implemented or recorded here as dropped.
- [ ] The deliberate V2 stubs (`shell`, `skill`, `compact`, `wait`) return real values or are
      documented as permanent and removed from the `OperationUnavailableError` path.
- [ ] Exit: `packages/opencode/src/session/` no longer exists as a runtime; the CLI, server, and
      desktop sidecar all drive `SessionV2`.

### M5 — Delete the remaining V1 contracts

- [ ] `packages/core/src/v1/` and `packages/schema/src/*-v1.ts` are removed once the compatibility
      consumers stop reading them (`packages/schema/AGENTS.md` calls this "temporary coexistence").
- [ ] Exit: no `V1` or `V2` naming remains in current namespaces.

## Verification

```sh
# Regenerate the inventory numbers above.
for d in session tool permission plugin config project account control-plane share skill; do
  printf "%-14s core=%s legacy=%s\n" "$d" \
    "$(find packages/core/src/$d -name '*.ts' -exec cat {} + | wc -l)" \
    "$(find packages/opencode/src/$d -name '*.ts' -exec cat {} + | wc -l)"
done

# Prove current code does not reach into the legacy tree.
grep -rn 'packages/opencode/src' packages/core/src packages/schema/src packages/protocol/src || echo "boundary intact"
```

## Out of scope

- Renaming `V2` out of current namespaces; that is tracked by `packages/schema/AGENTS.md`.
- The `packages/opencode` CLI surface itself, which remains the assembly point for the App, TUI, and
  desktop sidecar even after the legacy runtime is gone.
