import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { Config } from "@opencode-ai/core/config"
import { ConfigSkillPlugin } from "@opencode-ai/core/config/plugin/skill"
import { Global } from "@opencode-ai/core/global"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SkillV2 } from "@opencode-ai/core/skill"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"
import { host } from "../plugin/host"

const it = testEffect(Layer.empty)
const decode = Schema.decodeUnknownSync(Config.Info)

const directory = AbsolutePath.make("/repo/packages/app")

// Runs the plugin and collects the sources it registers. `skillDirectories` is
// applied to OPENCODE_SKILL_DIRECTORIES for the duration of the effect so the
// environment is restored afterwards.
const collectSources = (skillDirectories?: string) =>
  Effect.gen(function* () {
    const sources: SkillV2.Source[] = []
    const transform = Effect.fnUntraced(function* (update: (draft: SkillV2.Draft) => void | Effect.Effect<void>) {
      const result = update({
        source: (source) => {
          sources.push(source)
        },
        list: () => sources,
      })
      if (Effect.isEffect(result)) yield* result
      const dispose = Effect.sync(() => {
        sources.length = 0
      })
      yield* Effect.addFinalizer(() => dispose)
      return { dispose }
    })

    const previous = process.env["OPENCODE_SKILL_DIRECTORIES"]
    if (skillDirectories === undefined) delete process.env["OPENCODE_SKILL_DIRECTORIES"]
    else process.env["OPENCODE_SKILL_DIRECTORIES"] = skillDirectories
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env["OPENCODE_SKILL_DIRECTORIES"]
        else process.env["OPENCODE_SKILL_DIRECTORIES"] = previous
      }),
    )

    yield* ConfigSkillPlugin.Plugin.effect(
      host({
        skill: { transform, reload: () => Effect.void },
      }),
    ).pipe(
      Effect.provideService(Global.Service, Global.Service.of({ ...Global.make(), home: "/home/test" })),
      Effect.provideService(Location.Service, Location.Service.of(location({ directory }))),
      Effect.provideService(
        Config.Service,
        Config.Service.of({
          entries: () =>
            Effect.succeed([
              new Config.Directory({ type: "directory", path: AbsolutePath.make("/repo/.opencode") }),
              new Config.Document({
                type: "document",
                info: decode({
                  skills: ["./skills", "~/shared-skills", "/opt/skills", "https://example.test/skills/"],
                }),
              }),
            ]),
        }),
      ),
    )

    return sources
  })

describe("ConfigSkillPlugin.Plugin", () => {
  it.effect("registers configured skill directories and URLs", () =>
    Effect.gen(function* () {
      const sources = yield* collectSources()

      expect(sources).toEqual([
        SkillV2.DirectorySource.make({
          type: "directory",
          path: AbsolutePath.make(path.join("/repo/.opencode", "skill")),
        }),
        SkillV2.DirectorySource.make({
          type: "directory",
          path: AbsolutePath.make(path.join("/repo/.opencode", "skills")),
        }),
        SkillV2.DirectorySource.make({ type: "directory", path: AbsolutePath.make(path.join(directory, "skills")) }),
        SkillV2.DirectorySource.make({
          type: "directory",
          path: AbsolutePath.make(path.join("/home/test", "shared-skills")),
        }),
        SkillV2.DirectorySource.make({ type: "directory", path: AbsolutePath.make("/opt/skills") }),
        SkillV2.UrlSource.make({ type: "url", url: "https://example.test/skills/" }),
      ])
    }),
  )

  it.effect("registers the directories listed in OPENCODE_SKILL_DIRECTORIES", () =>
    Effect.gen(function* () {
      const sources = yield* collectSources(
        ["/opt/superpowers", "~/writing-skills", "./extra-skills"].join(path.delimiter),
      )

      expect(sources.slice(-3)).toEqual([
        SkillV2.DirectorySource.make({ type: "directory", path: AbsolutePath.make("/opt/superpowers") }),
        SkillV2.DirectorySource.make({
          type: "directory",
          path: AbsolutePath.make(path.join("/home/test", "writing-skills")),
        }),
        SkillV2.DirectorySource.make({
          type: "directory",
          path: AbsolutePath.make(path.join(directory, "extra-skills")),
        }),
      ])
    }),
  )

  it.effect("ignores empty entries in OPENCODE_SKILL_DIRECTORIES", () =>
    Effect.gen(function* () {
      const sources = yield* collectSources(["/opt/a", "", "   ", "/opt/b"].join(path.delimiter))

      expect(sources.slice(-2)).toEqual([
        SkillV2.DirectorySource.make({ type: "directory", path: AbsolutePath.make("/opt/a") }),
        SkillV2.DirectorySource.make({ type: "directory", path: AbsolutePath.make("/opt/b") }),
      ])
    }),
  )
})
