/**
 * Resolves the sidecar startup stall timeout.
 *
 * A cold start on a slow machine (antivirus scan, first run after an upgrade, cold disk) can exceed
 * the built-in 60s window, and the failure then surfaces as an opaque "server did not start"
 * dialog. Reading the window from the environment lets those setups raise it without patching the
 * bundle, while an invalid value must never disable the guard.
 *
 * Kept free of any Electron import so it stays unit-testable: the desktop test suite runs under bun
 * and cannot load `electron`.
 */
export const DEFAULT_STARTUP_STALL_TIMEOUT_MS = 60_000

export function resolveStartupStallTimeout(
  value: string | undefined = process.env.OPENCODE_SIDECAR_STARTUP_TIMEOUT_MS,
) {
  if (!value) return DEFAULT_STARTUP_STALL_TIMEOUT_MS
  const parsed = Number(value)
  // Reject anything that is not a positive, finite number of milliseconds so a typo cannot remove
  // the guard entirely (which would leave a hung sidecar waiting forever).
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_STARTUP_STALL_TIMEOUT_MS
  return parsed
}
