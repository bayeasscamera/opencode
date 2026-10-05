export * as SubagentEngine from "./engine"

import { Context, Effect, Layer } from "effect"
import path from "path"
import { makeLocationNode } from "../effect/app-node"
import { Path } from "../global"
import { Location } from "../location"
import { SubagentMarkdownLoader } from "./markdown-loader"

export type SubagentRole =
  | "researcher"
  | "code_builder"
  | "code_reviewer"
  | "tester"
  | "general"
  | "ui_designer"
  | "brainstormer"
  | "critic"
  | "editor"
  | "outliner"
  | "writer"
  | (string & {})

export interface SubagentPersona {
  readonly role: SubagentRole
  readonly title: string
  readonly systemPrompt: string
  readonly recommendedTools: readonly string[]
}

export const PERSONAS: Record<string, SubagentPersona> = {
  researcher: {
    role: "researcher",
    title: "Codebase & Documentation Researcher",
    systemPrompt:
      "Tu es un sous-agent spécialisé dans la recherche et l'exploration de code. Analyse l'architecture, cherche les symboles et lis les fichiers pour synthétiser les informations clés sans modifier le code.",
    recommendedTools: ["read", "grep", "glob", "websearch", "webfetch"],
  },
  code_builder: {
    role: "code_builder",
    title: "Feature & Refactoring Builder",
    systemPrompt:
      "Tu es un sous-agent autonome expert en développement et refactoring. Tu écris du code propre, modulaire et respectes strictement les directives du projet.",
    recommendedTools: ["read", "edit", "write", "apply_patch", "bash", "grep", "glob"],
  },
  code_reviewer: {
    role: "code_reviewer",
    title: "Code Reviewer & Auditor",
    systemPrompt:
      "Tu es un sous-agent d'audit de code et de revue critique. Examine les diffs, détecte les régressions, failles de sécurité, fuites mémoire et non-respect des conventions.",
    recommendedTools: ["read", "grep", "glob", "observer"],
  },
  tester: {
    role: "tester",
    title: "Test Engineer & Quality Assurance",
    systemPrompt:
      "Tu es un sous-agent d'assurance qualité et d'écriture de tests. Vérifie la robustesse, écris des tests unitaires et d'intégration et valide les cas limites.",
    recommendedTools: ["read", "edit", "write", "bash"],
  },
  general: {
    role: "general",
    title: "General Purpose Assistant",
    systemPrompt:
      "Tu es un sous-agent polyvalent capable de mener des tâches autonomes complexes par étapes.",
    recommendedTools: ["read", "edit", "write", "bash", "grep", "glob", "websearch"],
  },
  ui_designer: {
    role: "ui_designer",
    title: "UI/UX & Frontend Designer (Impeccable)",
    systemPrompt:
      "Tu es un sous-agent designer d'interface appliquant les principes Impeccable. Tu évites les clichés IA (gradients violets, Inter uniforme, empilement de cartes). Tu travailles sur la hiérarchie visuelle, l'espacement, la typographie, l'accessibilité et les micro-interactions.",
    recommendedTools: ["read", "edit", "write", "computer", "observer"],
  },
  brainstormer: {
    role: "brainstormer",
    title: "Architecture & Solution Brainstormer",
    systemPrompt:
      "Tu es un sous-agent d'exploration créative et d'architecture. Explore plusieurs alternatives, confronte les trade-offs et structure des options claires avant tout engagement de code.",
    recommendedTools: ["read", "grep", "glob", "websearch"],
  },
  critic: {
    role: "critic",
    title: "Continuity & Logic Critic",
    systemPrompt:
      "Tu es un sous-agent de critique impitoyable et de vérification de continuité. Traque les incohérences logiques, faiblesses d'implémentation et ruptures de contrat d'interface.",
    recommendedTools: ["read", "grep", "glob", "observer"],
  },
  editor: {
    role: "editor",
    title: "Content & Code Distiller",
    systemPrompt:
      "Tu es un sous-agent d'édition et de distillation. Ton but est de simplifier, élaguer le code ou le texte inutile, clarifier la structure et maximiser la densité d'information.",
    recommendedTools: ["read", "edit", "write"],
  },
  outliner: {
    role: "outliner",
    title: "Plan & Roadmap Outliner",
    systemPrompt:
      "Tu es un sous-agent de planification stratégique. Découpe les projets et refactorings complexes en étapes atomiques, mesurables et vérifiables.",
    recommendedTools: ["read", "grep", "glob"],
  },
  writer: {
    role: "writer",
    title: "Technical & RFC Writer",
    systemPrompt:
      "Tu es un sous-agent de rédaction technique. Rédige des documentations claires, des spécifications précises, des RFCs et des guides d'architecture sans verbiage superflu.",
    recommendedTools: ["read", "write", "edit", "grep"],
  },
}

export type TaskStatus = "registered" | "running" | "completed" | "error" | "cancelled"

export interface TaskLog {
  readonly timestamp: number
  readonly message: string
}

export interface SubagentTask {
  readonly id: string
  readonly role: SubagentRole
  readonly description: string
  readonly prompt: string
  readonly background: boolean
  status: TaskStatus
  sessionID?: string
  result?: string
  error?: string
  pendingDirectives?: string[]
  readonly logs: TaskLog[]
  readonly createdAt: number
  updatedAt: number
}

export interface CreateTaskInput {
  readonly role: string
  readonly prompt: string
  readonly description?: string
  readonly background?: boolean
  readonly taskId?: string
}

export interface Interface {
  readonly getPersona: (role: string) => SubagentPersona
  readonly createTask: (input: CreateTaskInput) => Effect.Effect<SubagentTask>
  readonly getTask: (id: string) => SubagentTask | undefined
  readonly listTasks: () => SubagentTask[]
  readonly startTask: (id: string, sessionID: string) => Effect.Effect<void>
  readonly appendLog: (id: string, message: string) => Effect.Effect<void>
  readonly completeTask: (id: string, result: string) => Effect.Effect<void>
  readonly failTask: (id: string, error: string) => Effect.Effect<void>
  readonly cancelTask: (id: string) => Effect.Effect<void>
  readonly retryTask: (id: string) => Effect.Effect<SubagentTask | undefined>
  readonly steerTask: (id: string, directive: string) => Effect.Effect<SubagentTask | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SubagentEngine") {}

const MAX_PERSISTED_TASKS = 100
const MAX_RESULT_LENGTH = 50_000

const fallbackPersona = (role: string): SubagentPersona => ({
  role,
  title: `Specialized Agent (${role})`,
  systemPrompt: `Tu es un sous-agent spécialisé dans le rôle : ${role}. Effectue la mission demandée de manière autonome et concise.`,
  recommendedTools: ["read", "edit", "write", "bash", "grep", "glob"],
})

const make = (input: { projectID: string; directory: string }) =>
  Effect.gen(function* () {
    // One persisted file per project so sibling projects never share task state.
    const tasksFile = path.join(Path.data, "subagents", `${input.projectID}.json`)
    const persisted = yield* Effect.promise(
      () => Bun.file(tasksFile).json().catch(() => []) as Promise<SubagentTask[]>,
    )
    const tasks = new Map(persisted.map((task) => [task.id, task]))
    const personas = new Map<string, SubagentPersona>(Object.entries(PERSONAS))
    for (const persona of SubagentMarkdownLoader.loadProjectSubagents(input.directory)) {
      personas.set(persona.role, persona)
    }

    const save = () => {
      const list = Array.from(tasks.values()).slice(0, MAX_PERSISTED_TASKS)
      void Bun.write(tasksFile, JSON.stringify(list, null, 2)).catch(() => {})
    }

    const mutate = (id: string, update: (task: SubagentTask) => void) =>
      Effect.sync(() => {
        const task = tasks.get(id)
        if (!task) return
        update(task)
        task.updatedAt = Date.now()
        save()
      })

    const api: Interface = {
      getPersona: (role) => personas.get(role) ?? fallbackPersona(role),
      getTask: (id) => tasks.get(id),
      listTasks: () => Array.from(tasks.values()).sort((a, b) => b.createdAt - a.createdAt),
      createTask: (input) =>
        Effect.sync(() => {
          const persona = personas.get(input.role) ?? fallbackPersona(input.role)
          const id = input.taskId || `subagent-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`
          const task: SubagentTask = {
            id,
            role: persona.role,
            description: input.description || `${persona.title}: ${input.prompt.slice(0, 60)}...`,
            prompt: input.prompt,
            background: input.background ?? false,
            status: "registered",
            logs: [{ timestamp: Date.now(), message: `Mission enregistrée pour le rôle [${persona.role}]` }],
            createdAt: Date.now(),
            updatedAt: Date.now(),
          }
          tasks.set(id, task)
          save()
          return task
        }),
      appendLog: (id, message) =>
        mutate(id, (task) => {
          task.logs.push({ timestamp: Date.now(), message })
        }),
      startTask: (id, sessionID) =>
        mutate(id, (task) => {
          task.status = "running"
          task.sessionID = sessionID
          task.logs.push({ timestamp: Date.now(), message: `Session enfant lancée : ${sessionID}` })
        }),
      completeTask: (id, result) =>
        mutate(id, (task) => {
          task.status = "completed"
          task.result = result.length > MAX_RESULT_LENGTH ? result.slice(0, MAX_RESULT_LENGTH) + "\n...[Output tronqué]" : result
          task.logs.push({ timestamp: Date.now(), message: "Tâche marquée terminée" })
        }),
      failTask: (id, error) =>
        mutate(id, (task) => {
          task.status = "error"
          task.error = error
          task.logs.push({ timestamp: Date.now(), message: `Erreur: ${error}` })
        }),
      cancelTask: (id) =>
        mutate(id, (task) => {
          task.status = "cancelled"
          task.logs.push({ timestamp: Date.now(), message: "Tâche annulée" })
        }),
      retryTask: (id) =>
        Effect.sync(() => {
          const task = tasks.get(id)
          if (!task) return undefined
          task.status = "registered"
          task.error = undefined
          task.logs.push({ timestamp: Date.now(), message: "Tâche réinitialisée à registered (aucun exécuteur lancé)" })
          task.updatedAt = Date.now()
          save()
          return task
        }),
      steerTask: (id, directive) =>
        Effect.sync(() => {
          const task = tasks.get(id)
          if (!task) return undefined
          task.pendingDirectives = [...(task.pendingDirectives ?? []), directive]
          task.logs.push({ timestamp: Date.now(), message: `Directive enregistrée: ${directive}` })
          task.updatedAt = Date.now()
          save()
          return task
        }),
    }

    return Service.of(api)
  })

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const location = yield* Location.Service
    return yield* make({ projectID: location.project.id, directory: location.project.directory })
  }),
)

/** Explicit-identity layer for tests and embedders that do not run under a Location. */
export const layerWith = (input: { projectID: string; directory: string }) => Layer.effect(Service, make(input))

export const node = makeLocationNode({ service: Service, layer, deps: [Location.node] })
