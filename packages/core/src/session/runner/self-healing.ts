export * as SelfHealing from "./self-healing"

/** Max auto-correction attempts per session drain. */
export const MAX_RETRIES = 3

/** Error patterns that trigger auto-correction / warnings. */
const ERROR_PATTERNS = [
  /error TS\d+:/i,
  /SyntaxError:/i,
  /TypeError:/i,
  /\bfailed\b.*\b(test|spec)\b/i,
  /FAIL\s+\S+\.(test|spec)\.(ts|js)/,
  /npm ERR!/i,
  /bun:\s*error/i,
  /\d+ error[s]?/i,
]

export interface HealingState {
  readonly retries: number
  readonly lastError: string
}

/**
 * Analyse tool output and decide if auto-correction is needed.
 * Returns the error message to inject, or undefined if output looks OK.
 */
export function detectFailure(stdout: string, exitCode: number | null): string | undefined {
  if (exitCode === 0) return undefined
  const text = stdout.trim()
  if (!text) return undefined
  for (const pattern of ERROR_PATTERNS) {
    if (pattern.test(text)) return text.slice(0, 2000)
  }
  if (exitCode !== 0 && exitCode !== null) return text.slice(0, 2000)
  return undefined
}

/**
 * Format a self-correction prompt to inject into the session.
 */
export function formatCorrectionPrompt(error: string, attempt: number): string {
  return `[Self-Healing — attempt ${attempt}/${MAX_RETRIES}]

The previous command failed with:

\`\`\`
${error}
\`\`\`

Please analyze this error and fix it. Run the command again after fixing.`
}
