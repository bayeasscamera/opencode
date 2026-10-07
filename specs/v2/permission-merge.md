# Permission Merge (M2)

Status: **design** — the safety net (M2.1) is in place; the merge is not started.
Related: `specs/v2/legacy-decommission.md` (M2), `packages/opencode/test/permission/matcher-parity.test.ts`.

## Why this is not a mechanical merge

Two permission evaluators decide whether an action runs:

- **V1 — `packages/opencode/src/permission/index.ts`** (legacy, 223 lines). Rule shape
  `{ permission, pattern, action }`; rules arrive **from the caller** on every `ask`; "always" answers
  accumulate **in memory** per instance.
- **V2 — `packages/core/src/permission.ts`** (current, 332 lines). Rule shape
  `{ action, resource, effect }`; the ruleset is **resolved internally** from the agent; "always"
  answers are **persisted on disk** per project.

They are the same idea with different plumbing, so merging them changes _what gets asked_, not just
where the code lives. Getting it wrong means either a prompt that should have appeared does not, or a
deny is bypassed.

## What is already shared (locked by test)

Both call the **same** `Wildcard.match` (`core/src/util/wildcard.ts`) and apply the same policy:
`findLast` over the flattened rulesets, defaulting to `ask` when nothing matches. The 13 cases in
`matcher-parity.test.ts` pin that equivalence, including wildcard handling, ordering, backslash
normalisation, case sensitivity and ruleset flattening. **The matcher must not move during the
merge**; the differences below live in the pipeline around it.

## Divergences the merge has to decide

| #   | Aspect              | V1 (legacy)                                                     | V2 (current)                                                                                  | Risk if ignored                                          |
| --- | ------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 1   | Rule vocabulary     | `permission / pattern / action`                                 | `action / resource / effect`                                                                  | silent translation gaps                                  |
| 2   | Ruleset source      | **caller-supplied** on each `ask` (`AskInput.ruleset`)          | resolved from the **agent** (`agents.resolve`)                                                | a caller stops passing rules → everything becomes `ask`  |
| 3   | "always" answers    | **in memory**, per `InstanceState`, lost on restart             | **on disk**, project-scoped (`PermissionSaved`)                                               | approvals survive (or not) differently than users expect |
| 4   | Deny vs saved allow | ruleset then `approved`, `findLast` → a later allow **can** win | explicit hard-deny pass first, so a persisted allow **cannot** override an agent deny         | **security-relevant**: a bypass appears or disappears    |
| 5   | Contract            | `ask` throws `DeniedError` and awaits the prompt                | `ask` returns `{ id, effect }`; `assert` throws and awaits; `prompt:false` relaxes only `ask` | callers must migrate one by one                          |
| 6   | Events              | `permission.asked` / `.replied`                                 | `permission.v2.asked` / `.replied`                                                            | App/TUI must migrate before V1 is deleted                |
| 7   | Scope               | `InstanceState` per directory                                   | Location node (`makeLocationNode`)                                                            | parallel state during the transition                     |
| 8   | Config → rules      | `fromConfig` with `~` / `$HOME` expansion                       | **no equivalent** in V2                                                                       | `~` patterns silently stop being expanded                |
| 9   | Tool filtering      | `disabled` / `visibleTools`                                     | `ToolRegistry.whollyDisabled` (M3)                                                            | tool lists diverge                                       |
| 10  | Logging             | `Effect.logInfo("evaluated", …)` on every decision              | none                                                                                          | noise is removed or kept deliberately                    |

## Migration order

Each step is a separate PR, and the parity test guards every one of them. Steps 1 and 2 touch no
call site.

1. **M2.1 — lock the matcher.** Done: `packages/opencode/test/permission/matcher-parity.test.ts`.
2. **M2.2 — vocabulary bridge.** One translation helper between the two rule shapes, proven
   round-trip by the parity corpus extended to cover `fromConfig` output (including `~`/`$HOME`).
   Still no behaviour change.
3. **M2.3 — single ruleset source.** Feed V1's `ask` from the V2 resolver (agent + session) instead
   of `AskInput.ruleset`, then stop accepting a caller-supplied ruleset. Divergence #2 closes; if a
   caller forgets, the resolver answers `deniedByDefault` rather than silently asking.
4. **M2.4 — persist "always".** Point V1's approvals at `PermissionSaved` so both evaluators answer
   the same after a restart. Decide explicitly whether a persisted allow may override a deny
   (divergence #4): V2's answer (**no**) is the correct one and should be adopted.
5. **M2.5 — migrate call sites** from `Permission.ask` to `PermissionV2.assert`, one caller per PR,
   adopting the error taxonomy (`DeniedError`→`BlockedError`, `RejectedError`→`DeclinedError`,
   `CorrectedError`→`CorrectedError`).
6. **M2.6 — migrate consumers** (App, TUI, `packages/session-ui`) to the `permission.v2.*` events,
   then remove the `permission.asked` / `.replied` entries from the public manifest.
7. **M2.7 — delete V1** (`permission/index.ts`, `permission/arity.ts`, `core/src/v1/permission.ts`)
   once nothing imports them; `packages/core/test/architecture-boundary.test.ts` already fails on a
   new import edge, so the last reference is visible.

## Exit criteria

- One evaluator, reachable through one contract (`ask`/`assert` with the same error taxonomy).
- One event family in the public manifest.
- The guard suites cover the merged path:
  `packages/core/test/tool-permission-guards.test.ts`,
  `packages/core/test/tool-permission-real.test.ts`, and the parity corpus here.
- No caller passes its own ruleset, and a persisted "allow" can never override a deny.

## Non-goals

- Redesigning what the rules _mean_ (which actions exist, what a resource is).
- Merging tool filtering, which belongs to M3 (`ToolRegistry`).

## Risks during the transition

- **Double prompts** while both evaluators are live for the same action; migrate per call site, not
  in bulk.
- **Silent `ask`** if V1 loses its caller-supplied ruleset before M2.3 lands.
- **A deny bypassed by a persisted allow** if step 4 adopts V1's ordering instead of V2's.
