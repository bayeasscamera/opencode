export * as BashReadOnly from "./bash-readonly"

import os from "node:os"
import path from "node:path"

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
 * Being non-mutating is not the same as being safe: `cat` cannot write, but
 * `cat ~/.ssh/id_rsa` still leaks a key. `referencesSensitivePath` covers that
 * second question, and callers must ask both before skipping a prompt.
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

/** Credential directories under the user's home, relative to it. */
const SENSITIVE_DIRECTORIES = [
  ".ssh",
  ".aws",
  ".gnupg",
  ".kube",
  ".docker",
  ".config/gcloud",
  ".config/gh",
]

/**
 * Filenames that hold credentials wherever they live. The bare directory names are listed too so
 * that `ls ~/.gnupg` is caught on the token itself, not only on a path that descends into it.
 */
const SENSITIVE_BASENAMES = new Set([
  ".npmrc",
  ".netrc",
  ".git-credentials",
  ".pgpass",
  ".gnupg",
  ".kube",
  ".docker",
  "auth.json",
])

/** Filename shapes that mark a file as a secret. */
const SENSITIVE_NAMES = [
  /^\.env/,
  /^id_rsa/,
  // Credential stores and private keys, by extension.
  /\.pem$/,
  /\.key$/,
  /\.p12$/,
  /\.pfx$/,
  /\.keystore$/,
  // Tool-generated dumps. Deliberately prefix matches: `credentials.json`, `secrets.yaml` and
  // `credentials` all count, and a false positive only costs an extra prompt.
  /^credentials/,
  /^secrets/,
]

const isSensitiveName = (name: string) =>
  SENSITIVE_BASENAMES.has(name) || SENSITIVE_NAMES.some((pattern) => pattern.test(name))

/** True when `child` is `parent` itself or lives under it. */
const contains = (parent: string, child: string) =>
  child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`)

/**
 * Returns true when an argument of the command points at a credential file, a credential
 * directory, or a path outside `cwd`.
 *
 * This is the second half of the auto-approval decision. `isReadOnly` answers "can this command
 * change anything"; this answers "would running it disclose anything the caller did not already
 * have". `cat ~/.ssh/id_rsa`, `cat .env`, `ls ~/.aws` and `cat /etc/passwd` are all read-only and
 * all must still be approved, so callers check both functions before skipping a prompt.
 *
 * Fail-safe: an unparsable or unrecognised token is treated as suspicious.
 */
export function referencesSensitivePath(command: string, cwd: string): boolean {
  const trimmed = command.trim()
  if (!trimmed) return false
  const home = os.homedir()
  const root = path.resolve(cwd)

  return tokens(trimmed)
    .map(unquote)
    .some((token) => {
      const value = token.replace(/[;,|&]+$/, "")
      if (!value || value.startsWith("-")) return false
      const expanded = value.startsWith("~") ? path.join(home, value.slice(1)) : value
      const resolved = path.resolve(root, expanded)

      // A credential filename is sensitive wherever it lives, including as a bare relative name.
      if (isSensitiveName(path.basename(resolved))) return true

      // Everything else is only suspicious when the token actually denotes a path.
      if (!value.includes("/") && !value.startsWith("~") && !value.startsWith(".")) return false

      const relative = path.relative(home, resolved)
      if (SENSITIVE_DIRECTORIES.some((dir) => relative === dir || relative.startsWith(`${dir}${path.sep}`)))
        return true

      return !contains(root, resolved)
    })
}
