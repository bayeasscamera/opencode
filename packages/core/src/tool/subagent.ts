export * as SubagentTool from "./subagent"

import { Effect, Layer, Ref, Schema } from "effect"
import { AgentV2 } from "../agent"
import { makeLocationNode } from "../effect/app-node"
import { SessionMessage } from "../session/message"
import { SessionSchema } from "../session/schema"
import type { SessionV2 } from "../session"
import { SubagentEngine } from "../subagent"
import { SubagentRuntime } from "../subagent/runtime"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "subagent"

const ACTIONS = ["run", "list", "status", "cancel", "retry", "logs", "steer"] as const

// Read-only roles may not write, edit, patch, or run shell commands.
const READ_ONLY_ROLES = new Set(["researcher", "code_reviewer", "brainstormer", "critic", "outliner"])
const MAX_STEPS = 25
// Consecutive inactive polls required before a child Session counts as settled.
const IDLE_CONFIRMATIONS = 3
// Operational knobs in milliseconds. Tests shorten them; the defaults bound a real subagent run.
const positiveMs = (value: string | undefined, fallback: number) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}
const timeoutMs = () => positiveMs(process.env.OPENCODE_SUBAGENT_TIMEOUT_MS, 600_000)
const pollMs = () => positiveMs(process.env.OPENCODE_SUBAGENT_POLL_MS, 400)

type Rule = { readonly action: string; readonly resource: string; readonly effect: "allow" | "deny" | "ask" }

/** Permission ruleset applied to the child agent. Exported so the policy is testable directly. */
export const rulesFor = (role: string): Rule[] => [
  // A subagent never spawns another subagent.
  { action: "subagent", resource: "*", effect: "deny" },
  ...(READ_ONLY_ROLES.has(role)
    ? ["write", "edit", "apply_patch", "bash"].map((action): Rule => ({ action, resource: "*", effect: "deny" }))
    : []),
]

// Waits until the child Session is no longer active, requiring several consecutive inactive
// polls so a not-yet-started drain is never mistaken for a finished one.
const waitIdle = (sessions: SessionV2.Interface, id: SessionSchema.ID) =>
  Effect.gen(function* () {
    let idle = 0
    while (idle < IDLE_CONFIRMATIONS) {
      yield* Effect.sleep(pollMs())
      const active = yield* sessions.active
      idle = active.has(id) ? 0 : idle + 1
    }
  })

// Newest assistant message that carries non-empty text. `messages` is ordered newest first.
const lastAssistantText = (messages: ReadonlyArray<SessionMessage.Message>) => {
  for (const message of messages) {
    if (message.type !== "assistant") continue
    const text = message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim()
    if (text.length > 0) return text
  }
  return undefined
}

export const Input = Schema.Struct({
  action: Schema.Literals(ACTIONS).pipe(Schema.optional).annotate({
    description: [
      "'run': Lance un vrai sous-agent (session enfant) et renvoie sa réponse réelle.",
      "'list': Liste les missions enregistrées pour ce projet.",
      "'status': Affiche une mission enregistrée.",
      "'cancel': Marque une mission annulée dans le registre.",
      "'retry': Réinitialise une mission à l'état registered.",
      "'logs': Affiche le journal d'une mission.",
      "'steer': Enregistre une directive pour une mission.",
    ].join(" "),
  }),
  role: Schema.String.pipe(Schema.optional).annotate({
    description: "Rôle du sous-agent ('researcher', 'code_builder', ... ou personnalisé).",
  }),
  prompt: Schema.String.pipe(Schema.optional).annotate({
    description: "Mission à exécuter (requise pour 'run') ou directive à enregistrer ('steer').",
  }),
  directive: Schema.String.pipe(Schema.optional).annotate({
    description: "Directive d'orientation à enregistrer pour l'action 'steer'.",
  }),
  task_id: Schema.String.pipe(Schema.optional).annotate({
    description: "Identifiant d'une mission enregistrée.",
  }),
})

export const Output = Schema.Struct({
  text: Schema.String,
  task_id: Schema.String.pipe(Schema.optional),
  status: Schema.String.pipe(Schema.optional),
})

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const engine = yield* SubagentEngine.Service
    // AgentV2 is Location-scoped, so the tool depends on it directly. SessionV2 is not
    // reachable from a Location-scoped node and is read through SubagentRuntime instead.
    const agents = yield* AgentV2.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Lance un vrai sous-agent : une session séparée avec son propre rôle, ses outils limités et une durée maximale. " +
            "'run' attend la fin et renvoie sa réponse réelle. 'list', 'status' et 'logs' consultent le registre.",
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const action = input.action ?? "run"

              if (action === "list") {
                const tasks = engine.listTasks()
                if (tasks.length === 0) return { text: "Aucune mission de sous-agent enregistrée pour ce projet." }
                const formatted = tasks
                  .slice(0, 10)
                  .map((task) => `- [${task.id}] **${task.role}** (${task.status}) : ${task.description.slice(0, 80)}`)
                  .join("\n")
                return { text: `### Missions enregistrées (${tasks.length}) :\n${formatted}` }
              }

              if (action === "status") {
                if (!input.task_id) return { text: "Erreur : 'task_id' requis pour consulter une mission." }
                const task = engine.getTask(input.task_id)
                if (!task) return { text: `Mission introuvable pour l'id : ${input.task_id}` }
                return {
                  text: [
                    `<subagent id="${task.id}" role="${task.role}" state="${task.status}">`,
                    `<description>${task.description}</description>`,
                    task.sessionID ? `<session>${task.sessionID}</session>` : "",
                    task.result ? `<result>\n${task.result}\n</result>` : "",
                    task.error ? `<error>\n${task.error}\n</error>` : "",
                    `</subagent>`,
                  ]
                    .filter(Boolean)
                    .join("\n"),
                  task_id: task.id,
                  status: task.status,
                }
              }

              if (action === "cancel") {
                if (!input.task_id) return { text: "Erreur : 'task_id' requis pour annuler une mission." }
                const task = engine.getTask(input.task_id)
                if (!task) return { text: `Mission introuvable pour l'id : ${input.task_id}` }
                const sessions = SubagentRuntime.sessions()
                if (task.sessionID && sessions) yield* sessions.interrupt(SessionSchema.ID.make(task.sessionID))
                yield* engine.cancelTask(input.task_id)
                return {
                  text: `Mission ${input.task_id} annulée${task.sessionID ? ` (session ${task.sessionID} interrompue)` : ""}.`,
                  task_id: input.task_id,
                  status: "cancelled",
                }
              }

              if (action === "retry") {
                if (!input.task_id) return { text: "Erreur : 'task_id' requis pour réinitialiser une mission." }
                const retried = yield* engine.retryTask(input.task_id)
                if (!retried) return { text: `Mission introuvable pour l'id : ${input.task_id}` }
                return {
                  text: `Mission ${input.task_id} réinitialisée à l'état registered (aucun exécuteur n'est lancé).`,
                  task_id: input.task_id,
                  status: retried.status,
                }
              }

              if (action === "logs") {
                if (!input.task_id) return { text: "Erreur : 'task_id' requis pour consulter le journal." }
                const task = engine.getTask(input.task_id)
                if (!task) return { text: `Mission introuvable pour l'id : ${input.task_id}` }
                const lines = task.logs
                  .map((log) => `[${new Date(log.timestamp).toLocaleTimeString()}] ${log.message}`)
                  .join("\n")
                return {
                  text: `### Journal de la mission [${task.id}] (${task.role}) :\n\n${lines}`,
                  task_id: task.id,
                  status: task.status,
                }
              }

              if (action === "steer") {
                if (!input.task_id) return { text: "Erreur : 'task_id' requis pour enregistrer une directive." }
                const directive = input.directive || input.prompt
                if (!directive) return { text: "Erreur : 'directive' ou 'prompt' requis pour enregistrer une directive." }
                const task = yield* engine.steerTask(input.task_id, directive)
                if (!task) return { text: `Mission introuvable pour l'id : ${input.task_id}` }
                return {
                  text: `Directive enregistrée pour la mission [${task.id}] (${task.role}) : "${directive}".`,
                  task_id: task.id,
                  status: task.status,
                }
              }

              if (!input.prompt) return { text: "Erreur : 'prompt' requis pour l'action 'run'." }
              const sessions = SubagentRuntime.sessions()
              if (!sessions)
                return {
                  text: "Erreur : le moteur de session n'est pas disponible dans ce processus (SubagentRuntime non publié). Aucun sous-agent n'a été lancé.",
                  status: "error",
                }
              const mission = input.prompt
              const role = input.role || "general"
              const limit = timeoutMs()
              const task = yield* engine.createTask({ role, prompt: mission })
              const persona = engine.getPersona(role)

              // The child Session ID is recorded so cleanup can interrupt it even when the run
              // fails, times out, or the parent tool call itself is interrupted.
              const childRef = yield* Ref.make<SessionSchema.ID | undefined>(undefined)
              const stopChild = Effect.gen(function* () {
                const childID = yield* Ref.get(childRef)
                if (childID) yield* sessions.interrupt(childID)
              })

              const outcome = yield* Effect.gen(function* () {
                const parent = yield* sessions.get(context.sessionID)

                // Declare a constrained child agent. The transform is scoped, so the agent
                // disappears once this run finishes. The id is unique per task so two concurrent
                // runs of the same role never dispose each other's agent when their scopes close.
                const agentID = AgentV2.ID.make(`subagent-${role}-${task.id}`)
                yield* agents.transform((draft) => {
                  draft.update(agentID, (agent) => {
                    agent.mode = "subagent"
                    agent.hidden = true
                    agent.system = persona.systemPrompt
                    agent.steps = MAX_STEPS
                    agent.permissions = rulesFor(role)
                  })
                })

                const child = yield* sessions.create({
                  location: parent.location,
                  agent: agentID,
                  parentID: parent.id,
                })
                yield* Ref.set(childRef, child.id)
                yield* engine.startTask(task.id, child.id)

                yield* sessions.prompt({ sessionID: child.id, prompt: { text: mission } })
                yield* waitIdle(sessions, child.id)
                const messages = yield* sessions.messages({ sessionID: child.id, order: "desc", limit: 10 })
                return lastAssistantText(messages)
              }).pipe(
                Effect.scoped,
                Effect.timeout(limit),
                Effect.onInterrupt(() => stopChild),
                Effect.exit,
              )

              yield* stopChild

              if (outcome._tag === "Failure") {
                yield* engine.failTask(task.id, `Le sous-agent a échoué ou a dépassé ${limit} ms.`)
                return {
                  text: `<subagent id="${task.id}" role="${role}" state="error">Le sous-agent a échoué ou a dépassé ${limit} ms. Aucun résultat fiable.</subagent>`,
                  task_id: task.id,
                  status: "error",
                }
              }
              if (!outcome.value) {
                yield* engine.failTask(task.id, "Le sous-agent n'a produit aucune réponse.")
                return {
                  text: `<subagent id="${task.id}" role="${role}" state="error">Le sous-agent n'a produit aucune réponse.</subagent>`,
                  task_id: task.id,
                  status: "error",
                }
              }
              yield* engine.completeTask(task.id, outcome.value)
              return {
                text: `<subagent id="${task.id}" role="${role}" state="completed">\n${outcome.value}\n</subagent>`,
                task_id: task.id,
                status: "completed",
              }
            }),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/subagent",
  layer,
  deps: [ToolRegistry.node, SubagentEngine.node, AgentV2.node],
})
