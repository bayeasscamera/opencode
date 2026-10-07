import { describe, expect, test } from "bun:test"
import { DEFAULT_STARTUP_STALL_TIMEOUT_MS, resolveStartupStallTimeout } from "./startup-timeout"

describe("sidecar startup stall timeout", () => {
  test("defaults to sixty seconds", () => {
    expect(resolveStartupStallTimeout()).toBe(60_000)
    expect(DEFAULT_STARTUP_STALL_TIMEOUT_MS).toBe(60_000)
  })

  test("accepts an explicit positive duration", () => {
    expect(resolveStartupStallTimeout("120000")).toBe(120_000)
    expect(resolveStartupStallTimeout("1")).toBe(1)
  })

  test("ignores values that would remove the guard", () => {
    // A typo must not disable the stall guard: anything non-finite, zero, or negative falls back to
    // the default rather than waiting forever for a sidecar that will never report ready.
    for (const value of ["", "0", "-1", "abc", "NaN", "Infinity", "1e999"]) {
      expect(resolveStartupStallTimeout(value)).toBe(DEFAULT_STARTUP_STALL_TIMEOUT_MS)
    }
  })
})
