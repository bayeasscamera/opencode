export * as Schedule from "./schedule"

import { Context, Effect, Layer } from "effect"
import { eq, desc } from "drizzle-orm"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { ScheduleTable, type ScheduleID } from "./sql"
import { ProjectV2 } from "../project"
import crypto from "crypto"

export type { ScheduleID }

export interface ScheduleEntry {
  readonly id: ScheduleID
  readonly project_id: ProjectV2.ID
  readonly name: string
  readonly cron: string
  readonly prompt: string
  readonly enabled: boolean
  readonly last_run_at: number | null
  readonly next_run_at: number | null
  readonly time_created: number
  readonly time_updated: number
}

export interface Interface {
  readonly create: (input: {
    project_id: ProjectV2.ID
    name: string
    cron: string
    prompt: string
  }) => Effect.Effect<ScheduleEntry>

  readonly list: (project_id: ProjectV2.ID) => Effect.Effect<ScheduleEntry[]>

  readonly remove: (id: ScheduleID) => Effect.Effect<void>

  readonly setEnabled: (id: ScheduleID, enabled: boolean) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Schedule") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    const create: Interface["create"] = (input) =>
      Effect.gen(function* () {
        const id = crypto.randomUUID() as ScheduleID
        const now = Date.now()
        const entry = {
          id,
          project_id: input.project_id,
          name: input.name,
          cron: input.cron,
          prompt: input.prompt,
          enabled: true,
          last_run_at: null,
          next_run_at: null,
          time_created: now,
          time_updated: now,
        }
        yield* db.insert(ScheduleTable).values(entry).pipe(Effect.orDie)
        return entry as ScheduleEntry
      })

    const list: Interface["list"] = (project_id) =>
      Effect.gen(function* () {
        const rows = yield* db
          .select()
          .from(ScheduleTable)
          .where(eq(ScheduleTable.project_id, project_id))
          .orderBy(desc(ScheduleTable.time_created))
          .pipe(Effect.orDie)
        return rows as ScheduleEntry[]
      })

    const remove: Interface["remove"] = (id) =>
      db.delete(ScheduleTable).where(eq(ScheduleTable.id, id)).pipe(Effect.orDie, Effect.asVoid)

    const setEnabled: Interface["setEnabled"] = (id, enabled) =>
      db
        .update(ScheduleTable)
        .set({ enabled, time_updated: Date.now() })
        .where(eq(ScheduleTable.id, id))
        .pipe(Effect.orDie, Effect.asVoid)

    return Service.of({ create, list, remove, setEnabled })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
