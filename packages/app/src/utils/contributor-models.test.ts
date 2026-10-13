import { describe, expect, test } from "bun:test"
import { contributorModelKey, isContributorAcked, isContributorModel, markContributorAcked } from "./contributor-models"

describe("isContributorModel", () => {
  test("matches both Meta Contributor models", () => {
    expect(isContributorModel("meta", "muse-spark-1.3-contributor")).toBe(true)
    expect(isContributorModel("meta", "muse-spark-1.2-contributor")).toBe(true)
  })

  test("recognizes discovered Wonder and future Muse contributor models", () => {
    expect(isContributorModel("meta", "muse-wonder-1.0-contributor")).toBe(true)
    expect(isContributorModel("meta", "muse-wonder-full-1.0-contributor")).toBe(true)
    expect(isContributorModel("meta", "muse-spark-1.4-contributor")).toBe(true)
  })

  test("rejects lookalikes", () => {
    expect(isContributorModel("meta", "muse-spark-1.3")).toBe(false)
    expect(isContributorModel("meta", "muse-spark-1.3-contributor-free")).toBe(false)
    expect(isContributorModel("opencode", "muse-spark-1.3-contributor-free")).toBe(false)
    expect(isContributorModel("anthropic", "claude-sonnet-5")).toBe(false)
    expect(isContributorModel("meta", "muse-wonder-full-1.0")).toBe(false)
    expect(isContributorModel("meta", "muse-wonder-full-1.0-contributor-free")).toBe(false)
    expect(isContributorModel("opencode", "muse-wonder-full-1.0-contributor")).toBe(false)
  })

  test("memory ack round-trips", () => {
    const ackKey = `session:ack-${crypto.randomUUID()}`
    const key = contributorModelKey("meta", "muse-spark-1.3-contributor")
    expect(isContributorAcked(ackKey)).toBe(false)
    markContributorAcked(ackKey)
    expect(isContributorAcked(ackKey)).toBe(true)
    expect(key).toBe("meta/muse-spark-1.3-contributor")
  })

  test("distinct draft scopes do not share acks", () => {
    const first = `draft:ack-${crypto.randomUUID()}`
    const second = `draft:ack-${crypto.randomUUID()}`
    expect(isContributorAcked(second)).toBe(false)
    markContributorAcked(first)
    expect(isContributorAcked(first)).toBe(true)
    expect(isContributorAcked(second)).toBe(false)
  })
})
