import { describe, expect, test } from "bun:test"
import { FileSystem, Integration, Permission, Project, Reference, Session, Workspace } from "../src"
import { EventManifest } from "../src/event-manifest"
import { IdeEvent } from "../src/ide-event"
import { SessionEvent } from "../src/session-event"
import { SessionTodo } from "../src/session-todo"
import { SessionV1 } from "../src/session-v1"
import { WorkspaceEvent } from "../src/workspace-event"

const typesOf = (definitions: ReadonlyArray<{ readonly type: string }>) => definitions.map((d) => d.type)

describe("public event manifest", () => {
  test("owns the complete public event surface", () => {
    // Counts pin the size of the surface at a point in time; the invariants below are what the
    // manifest actually promises. A new event should fail a duplicate check, not a frozen number.
    const serverTypes = typesOf(EventManifest.ServerDefinitions)
    const types = typesOf(EventManifest.Definitions)
    const durableKeys = EventManifest.Definitions.flatMap((definition) =>
      definition.durable === undefined ? [] : [`${definition.type}.${definition.durable.version}`],
    )
    expect(serverTypes.length).toBeGreaterThan(0)
    expect(new Set(serverTypes).size).toBe(serverTypes.length)
    expect(types.length).toBeGreaterThan(serverTypes.length)
    expect(new Set(types).size).toBe(types.length)
    expect(EventManifest.Latest.size).toBe(new Set(types).size)
    expect(EventManifest.Durable.size).toBe(new Set(durableKeys).size)
    expect(SessionV1.Event.Definitions).toEqual([
      SessionV1.Event.Created,
      SessionV1.Event.Updated,
      SessionV1.Event.Deleted,
      SessionV1.Event.MessageUpdated,
      SessionV1.Event.MessageRemoved,
      SessionV1.Event.PartUpdated,
      SessionV1.Event.PartRemoved,
      SessionV1.Event.PartDelta,
      SessionV1.Event.Diff,
      SessionV1.Event.Error,
    ])
  })

  test("uses canonical definitions for current public events", () => {
    expect(Session.Event).toBe(SessionEvent)
    expect(Session.Event.Definitions).toBe(SessionEvent.Definitions)
    expect(Workspace.Event).toBe(WorkspaceEvent)
    expect(Workspace.Event.Definitions).toBe(WorkspaceEvent.Definitions)
    expect(EventManifest.Latest.get("session.next.step.ended")).toBe(SessionEvent.Step.Ended)
    expect(EventManifest.Latest.get("todo.updated")).toBe(SessionTodo.Event.Updated)
    expect(EventManifest.Latest.get("project.updated")).toBe(Project.Event.Updated)
    expect(Project.Event.Definitions).toEqual([Project.Event.Updated])
    expect(FileSystem.Event.Definitions).toEqual([FileSystem.Event.Edited])
    expect(Integration.Event.Definitions).toEqual([Integration.Event.Updated, Integration.Event.ConnectionUpdated])
    expect(Permission.Event.Definitions).toEqual([Permission.Event.Asked, Permission.Event.Replied])
    expect(Reference.Event.Definitions).toEqual([Reference.Event.Updated])
    expect(EventManifest.Latest.has("ide.installed")).toBe(false)
    expect(IdeEvent.Definitions).toEqual([IdeEvent.Installed])
    // The three live V1 events are contributed by one spread, so they must stay contiguous and
    // ordered without depending on their absolute offset in the manifest.
    const messagePartDelta = typesOf(EventManifest.Definitions).indexOf("message.part.delta")
    expect(messagePartDelta).toBeGreaterThanOrEqual(0)
    expect(EventManifest.Definitions.slice(messagePartDelta, messagePartDelta + 3)).toEqual([
      SessionV1.Event.PartDelta,
      SessionV1.Event.Diff,
      SessionV1.Event.Error,
    ])
    expect(EventManifest.Durable.has("session.next.step.ended.1")).toBe(false)
    expect(EventManifest.Durable.get("session.next.step.ended.2")).toBe(SessionEvent.Step.Ended)
  })
})
