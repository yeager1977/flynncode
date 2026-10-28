import { describe, expect, test } from "bun:test"
import {
  createMaintenanceRelay,
  SIDECAR_MAINTENANCE_TIMEOUT,
  SIDECAR_START_STALL_TIMEOUT,
  stallTimeoutFor,
  type MaintenanceProgress,
} from "./sidecar-maintenance"

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

describe("createMaintenanceRelay", () => {
  test("broadcasts progress and keeps the latest for windows that open later", () => {
    const sent: MaintenanceProgress[] = []
    const relay = createMaintenanceRelay((progress) => sent.push(progress))
    expect(relay.latest()).toBeNull()

    relay.report({ phase: "compact", state: "started" })
    expect(relay.latest()).toEqual({ phase: "compact", state: "started" })

    relay.report({ phase: "compact", state: "finished" })
    expect(relay.latest()).toEqual({ phase: "compact", state: "finished" })
    expect(sent).toEqual([
      { phase: "compact", state: "started" },
      { phase: "compact", state: "finished" },
    ])
  })
})
