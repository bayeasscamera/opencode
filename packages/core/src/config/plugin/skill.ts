export * as ConfigSkillPlugin from "./skill"

import { define } from "../../plugin/internal"
import path from "path"
import { Effect } from "effect"
import { Config } from "../../config"
import { AbsolutePath } from "../../schema"
import { SkillV2 } from "../../skill"
import { Global } from "../../global"
import { Location } from "../../location"
import { Flag } from "../../flag/flag"

export const Plugin = define({
  id: "config-skill",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const global = yield* Global.Service
    const location = yield* Location.Service

    // `~/` is expanded against the home directory, then relative entries are
    // resolved against the Location so a config can stay portable.
    const resolveDirectory = (entry: string) => {
      const expanded = entry.startsWith("~/") ? path.join(global.home, entry.slice(2)) : entry
      return AbsolutePath.make(path.isAbsolute(expanded) ? expanded : path.join(location.directory, expanded))
    }

    yield* ctx.skill.transform(
      Effect.fn(function* (draft) {
        const entries = yield* config.entries()
        const directories = entries.flatMap((entry) => (entry.type === "directory" ? [entry.path] : []))
        const items = entries.flatMap((entry) => (entry.type === "document" ? (entry.info.skills ?? []) : []))
        for (const directory of directories) {
          draft.source(
            SkillV2.DirectorySource.make({ type: "directory", path: AbsolutePath.make(path.join(directory, "skill")) }),
          )
          draft.source(
            SkillV2.DirectorySource.make({
              type: "directory",
              path: AbsolutePath.make(path.join(directory, "skills")),
            }),
          )
        }
        for (const item of items) {
          if (URL.canParse(item) && /^(https?:)$/.test(new URL(item).protocol)) {
            draft.source(SkillV2.UrlSource.make({ type: "url", url: item }))
            continue
          }
          draft.source(SkillV2.DirectorySource.make({ type: "directory", path: resolveDirectory(item) }))
        }
        // Additional directories come from OPENCODE_SKILL_DIRECTORIES rather
        // than being hard-coded, so a checkout carries no machine-specific path.
        for (const entry of (Flag.OPENCODE_SKILL_DIRECTORIES ?? "").split(path.delimiter)) {
          const trimmed = entry.trim()
          if (trimmed.length === 0) continue
          draft.source(SkillV2.DirectorySource.make({ type: "directory", path: resolveDirectory(trimmed) }))
        }
      }),
    )
  }),
})
