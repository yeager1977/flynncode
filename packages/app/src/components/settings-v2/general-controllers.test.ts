import { describe, expect, test, vi } from "bun:test"
import { createRoot } from "solid-js"
import { createOptimisticToggle, createShellOptions, createSoundPreviewController } from "./general-controller-behavior"

describe("settings v2 controllers", () => {
  test("normalizes shell names and preserves an unavailable configured shell", () => {
    expect(
      createShellOptions({
        shells: [
          { path: "/bin/bash", name: "bash", acceptable: true },
          { path: "/opt/bash", name: "bash", acceptable: false },
          { path: "/bin/zsh", name: "zsh", acceptable: true },
        ],
        current: "fish",
      }),
    ).toEqual([
      { id: "auto", value: "", name: "", terminalOnly: false },
      { id: "/bin/bash", value: "/bin/bash", name: "/bin/bash", terminalOnly: false },
      { id: "/opt/bash", value: "/opt/bash", name: "/opt/bash", terminalOnly: true },
      { id: "/bin/zsh", value: "zsh", name: "zsh", terminalOnly: false },
      { id: "fish", value: "fish", name: "fish", terminalOnly: false },
    ])
  })

  test("debounces previews and stops owned audio on disposal", async () => {
    vi.useFakeTimers()
    try {
      const played: string[] = []
      const stopped: string[] = []
      const owned = createRoot((dispose) => ({
        dispose,
        preview: createSoundPreviewController(async (id) => {
          played.push(id ?? "")
          return () => stopped.push(id ?? "")
        }),
      }))

      owned.preview.play("first")
      vi.advanceTimersByTime(99)
      expect(played).toEqual([])

      owned.preview.play("second")
      vi.advanceTimersByTime(100)
      await Promise.resolve()
      expect(played).toEqual(["second"])

      owned.dispose()
      expect(stopped).toEqual(["second"])
    } finally {
      vi.useRealTimers()
    }
  })

  describe("optimistic toggle", () => {
    const setup = (source: { value: boolean }, resolveWith: boolean) =>
      createRoot((dispose) => {
        const updates: boolean[] = []
        const toggle = createOptimisticToggle(
          () => source.value,
          (checked) => {
            updates.push(checked)
            return Promise.resolve(resolveWith)
          },
        )
        return { dispose, updates, toggle }
      })

    test("clears the pending state on a successful write so the switch re-enables", async () => {
      const source = { value: false }
      const wired = setup(source, true)
      expect(wired.toggle.saving()).toBe(false)

      const turnOn = wired.toggle.toggle(true)
      expect(wired.toggle.value()).toBe(true)
      expect(wired.toggle.saving()).toBe(true)

      const settled = await turnOn
      expect(settled).toBe(true)
      expect(wired.updates).toEqual([true])
      expect(wired.toggle.saving()).toBe(false)
      expect(wired.toggle.value()).toBe(source.value)

      wired.dispose()
    })

    test("rolls back and clears the pending state on a failed write", async () => {
      const source = { value: false }
      const wired = setup(source, false)
      expect(wired.toggle.saving()).toBe(false)

      const turnOn = wired.toggle.toggle(true)
      expect(wired.toggle.value()).toBe(true)
      expect(wired.toggle.saving()).toBe(true)

      const settled = await turnOn
      expect(settled).toBe(false)
      expect(wired.updates).toEqual([true])
      expect(wired.toggle.saving()).toBe(false)
      expect(wired.toggle.value()).toBe(source.value)

      wired.dispose()
    })

    test("skips the write when the requested value already matches", async () => {
      const wired = setup({ value: true }, true)

      await wired.toggle.toggle(true)
      expect(wired.updates).toEqual([])
      expect(wired.toggle.saving()).toBe(false)

      wired.dispose()
    })
  })
})
