import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Memory } from "@opencode-ai/core/memory/memory"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, Memory.node])))
const projectID = Project.ID.make("proj_hindsight_test")

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: projectID, worktree: AbsolutePath.make("/project_hindsight"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

describe("Hindsight Memory (Retain, Recall, Reflect)", () => {
  it.effect("retains memories across episodic, procedural, and semantic categories", () =>
    Effect.gen(function* () {
      yield* setup
      const memory = yield* Memory.Service

      yield* memory.clear(projectID)

      // 1. Retain
      const m1 = yield* memory.retain({
        project_id: projectID,
        kind: "episodic",
        content: "Exécution bash 'npm test' a échoué car le port 3000 était occupé, résolu via port 3001.",
      })
      expect(m1.kind).toBe("episodic")

      const m2 = yield* memory.retain({
        project_id: projectID,
        kind: "procedural",
        content: "Pour déployer les lambdas, toujours exécuter 'bun run build' avant 'sst deploy'.",
      })
      expect(m2.kind).toBe("procedural")

      const m3 = yield* memory.retain({
        project_id: projectID,
        kind: "semantic",
        content: "L'entité 'Account' est le tenant racine; tout 'User' appartient à un Account.",
      })
      expect(m3.kind).toBe("semantic")

      // 2. Recall
      const recalled = yield* memory.recall({
        project_id: projectID,
        query: "port 3000",
      })
      expect(recalled.length).toBe(1)
      expect(recalled[0].content).toContain("3001")

      const semanticRecall = yield* memory.recall({
        project_id: projectID,
        query: "tenant",
        kind: "semantic",
      })
      expect(semanticRecall.length).toBe(1)
      expect(semanticRecall[0].content).toContain("Account")

      // 3. Reflect
      const reflection = yield* memory.reflect({
        project_id: projectID,
        topic: "Account",
      })
      expect(reflection).toContain("Hindsight Reflection")
      expect(reflection).toContain("Account")

      // 4. Render
      const rendered = yield* memory.render(projectID)
      expect(rendered).toBeDefined()
      expect(rendered).toContain("Hindsight")
      expect(rendered).toContain("Épisodes d'exécution")
      expect(rendered).toContain("Procédures & Recettes")
    }),
  )
})
