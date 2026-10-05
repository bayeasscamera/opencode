export * as BashReadOnly from "./bash-readonly"

/**
 * Token-based read-only command inspector.
 * Identifies commands that are purely consultative (no filesystem/state mutations)
 * to auto-approve them without a permission prompt.
 *
 * The command is parsed into shell tokens and every check compares the exact
 * program name (or git subcommand) — never a textual prefix. A command that
 * contains any shell operator (pipe, redirect, command substitution, compound
 * separators) is never auto-approved.
 *
 * Fail-safe: if uncertain → returns false (prompt user).
 */

const tokens = (command: string) => command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []
const unquote = (value: string) => value.replace(/^(['"])(.*)\1$/, "$2")

/** Operators or substitutions that make a command unverifiable. */
const SHELL_SYNTAX = /[|;&<>()`\n]/

/** Git subcommands that never mutate the repository, index, remotes, or worktree. */
const GIT_READ_ONLY_SUBCOMMANDS = new Set([
  "log",
  "diff",
  "status",
  "show",
  "blame",
  "ls-files",
  "shortlog",
  "rev-parse",
  "reflog",
  "describe",
  "ls-remote",
])

/** Flags accepted after mutating-capable git subcommands when listing only. */
const GIT_LIST_FLAGS = new Set([
  "-a",
  "--all",
  "-r",
  "--remotes",
  "-v",
  "-vv",
  "--list",
  "-l",
  "--show-current",
  "--contains",
  "--no-contains",
  "--merged",
  "--no-merged",
  "--points-at",
  "--sort",
  "--format",
  "--color",
])

/** find(1) primaries that execute programs or write files. */
const FIND_WRITING_PRIMARIES = new Set([
  "-delete",
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-fprintf",
  "-fprint",
  "-fprint0",
  "-fls",
])

/** ripgrep flags that execute an external program. */
const RG_EXEC_FLAGS = new Set(["--pre", "--pre-glob"])

type Validator = (args: readonly string[]) => boolean

/** Accepts any argument list — mutation is only possible via shell operators. */
const anyArgs: Validator = () => true

const validators = new Map<string, Validator>([
  ["cat", anyArgs],
  ["ls", anyArgs],
  ["head", anyArgs],
  ["tail", anyArgs],
  ["wc", anyArgs],
  ["file", anyArgs],
  ["stat", anyArgs],
  ["which", anyArgs],
  ["whereis", anyArgs],
  ["type", anyArgs],
  ["pwd", anyArgs],
  ["date", (args) => !args.some((arg) => arg === "-s" || arg.startsWith("--set"))],
  ["uname", anyArgs],
  ["id", anyArgs],
  ["whoami", anyArgs],
  ["hostname", (args) => args.every((arg) => arg.startsWith("-"))],
  ["uptime", anyArgs],
  ["df", anyArgs],
  ["du", anyArgs],
  ["free", anyArgs],
  ["ps", anyArgs],
  ["diff", (args) => !args.some((arg) => arg.startsWith("--output"))],
  ["sort", (args) => !args.some((arg) => arg === "-o" || arg.startsWith("--output"))],
  ["uniq", anyArgs],
  ["cut", anyArgs],
  ["jq", anyArgs],
  ["grep", (args) => !args.some((arg) => RG_EXEC_FLAGS.has(arg))],
  ["rg", (args) => !args.some((arg) => RG_EXEC_FLAGS.has(arg))],
  ["find", (args) => !args.some((arg) => FIND_WRITING_PRIMARIES.has(arg))],
  ["echo", anyArgs],
  ["env", (args) => args.every((arg) => arg.startsWith("-"))],
  ["printenv", (args) => args.length === 0],
  [
    "git",
    (args) => {
      const subcommand = args[0]
      if (!subcommand || subcommand.startsWith("-")) return false
      if (GIT_READ_ONLY_SUBCOMMANDS.has(subcommand))
        return !args.some((arg) => arg.startsWith("--output"))
      // branch/tag/remote mutate with positional args or specific flags: only
      // listing invocations (allow-listed flags, no positional args) pass.
      if (subcommand === "branch" || subcommand === "tag" || subcommand === "remote") {
        const flags = args.slice(1)
        return flags.length > 0 && flags.every((flag) => GIT_LIST_FLAGS.has(flag.split("=")[0]))
      }
      if (subcommand === "stash") return args[1] === "list"
      return false
    },
  ],
  [
    "bun",
    (args) => args[0] === "--version" || args[0] === "typecheck" || (args[0] === "run" && args[1] === "typecheck"),
  ],
  ["npm", (args) => args[0] === "--version" || args[0] === "-v"],
  ["pnpm", (args) => args[0] === "--version" || args[0] === "-v"],
  ["node", (args) => args[0] === "--version"],
  [
    "tsc",
    (args) =>
      args[0] === "--noEmit" && !args.some((arg) => arg === "--build" || arg === "-b" || arg === "--incremental"),
  ],
  [
    "tsgo",
    (args) =>
      args[0] === "--noEmit" && !args.some((arg) => arg === "--build" || arg === "-b" || arg === "--incremental"),
  ],
])

/**
 * Returns true if the command is a provably read-only query that can skip
 * the interactive permission prompt.
 */
export function isReadOnly(command: string): boolean {
  const trimmed = command.trim()
  if (!trimmed) return false
  if (SHELL_SYNTAX.test(trimmed)) return false

  const words = tokens(trimmed).map(unquote)
  if (words.length === 0) return false
  // Env-assignment prefixes (VAR=value cmd) can launch arbitrary programs.
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) return false

  const validator = validators.get(words[0])
  if (!validator) return false
  return validator(words.slice(1))
}
