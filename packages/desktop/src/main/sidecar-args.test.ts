import { describe, expect, it } from "bun:test"
import { sidecarArguments, sidecarNodeFlags } from "./sidecar-args"

// The upstream opencode-mobile plugin activates its LAN push server and tunnel
// only when the server process argv contains the literal `serve` token (its
// approximation of "opencode serve"). The desktop launches the server as a
// utility process with no argv tokens, so we pass the token it expects.

describe("sidecar argv", () => {
  it("includes the serve token upstream plugins gate on", () => {
    expect(sidecarArguments()).toContain("serve")
  })

  it("never includes the attach token", () => {
    expect(sidecarArguments()).not.toContain("attach")
  })
})

describe("sidecar node flags", () => {
  it("writes a near-limit heap snapshot on the dev channel", () => {
    expect(sidecarNodeFlags("dev")).toContain("--heapsnapshot-near-heap-limit=1")
    expect(sidecarNodeFlags("prod")).toEqual([])
  })
})