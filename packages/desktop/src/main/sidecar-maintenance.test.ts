import { describe, expect, test } from "bun:test"
import { SIDECAR_MAINTENANCE_TIMEOUT, SIDECAR_START_STALL_TIMEOUT, stallTimeoutFor } from "./sidecar-maintenance"

describe("stallTimeoutFor", () => {
  test("allows a long one-time compaction once it starts", () => {
    expect(stallTimeoutFor({ type: "maintenance", phase: "compact", state: "started" })).toBe(
      SIDECAR_MAINTENANCE_TIMEOUT,
    )
  })

  test("returns to the normal stall timeout when compaction finishes", () => {
    expect(stallTimeoutFor({ type: "maintenance", phase: "compact", state: "finished" })).toBe(
      SIDECAR_START_STALL_TIMEOUT,
    )
  })

  test("keeps the normal timeout for other messages", () => {
    expect(stallTimeoutFor({ type: "sync-status" })).toBe(SIDECAR_START_STALL_TIMEOUT)
  })
})
