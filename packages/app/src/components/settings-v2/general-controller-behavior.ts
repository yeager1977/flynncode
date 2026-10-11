import { onCleanup } from "solid-js"
import { createStore } from "solid-js/store"

export type ShellOption = {
  path: string
  name: string
  acceptable: boolean
}

export type ShellSelectOption = {
  id: string
  value: string
  name: string
  terminalOnly: boolean
}

export function createShellOptions(input: { shells: ShellOption[]; current: string | undefined }) {
  const counts = input.shells.reduce((result, shell) => {
    result.set(shell.name, (result.get(shell.name) ?? 0) + 1)
    return result
  }, new Map<string, number>())
  const options: ShellSelectOption[] = [
    { id: "auto", value: "", name: "", terminalOnly: false },
    ...input.shells.map((shell) => {
      const ambiguous = (counts.get(shell.name) ?? 0) > 1
      const name = ambiguous ? shell.path : shell.name
      return {
        id: shell.path,
        value: ambiguous ? shell.path : shell.name,
        name,
        terminalOnly: !shell.acceptable,
      }
    }),
  ]
  if (input.current && !options.some((option) => option.value === input.current)) {
    options.push({ id: input.current, value: input.current, name: input.current, terminalOnly: false })
  }
  return options
}

export function createSoundPreviewController(player: (id: string | undefined) => Promise<(() => void) | undefined>) {
  let cleanup: (() => void) | undefined
  let timeout: ReturnType<typeof setTimeout> | undefined
  let run = 0

  const stop = () => {
    run += 1
    cleanup?.()
    clearTimeout(timeout)
    cleanup = undefined
    timeout = undefined
  }
  const play = (id: string | undefined) => {
    stop()
    if (!id) return
    const current = ++run
    timeout = setTimeout(() => {
      timeout = undefined
      void player(id).then((next) => {
        if (run === current) {
          cleanup = next
          return
        }
        next?.()
      })
    }, 100)
  }

  onCleanup(stop)
  return { play, stop }
}

// Optimistic toggle: flips the displayed value immediately and clears the
// optimistic state whichever way the write resolves — the server truth takes
// over on success, the change rolls back on failure — so the switch can never
// stay disabled after a completed write.
export function createOptimisticToggle(current: () => boolean, update: (checked: boolean) => Promise<boolean>) {
  const [pending, setPending] = createStore<{ checked?: boolean }>({})
  const value = () => (pending.checked === undefined ? current() : pending.checked)
  return {
    value,
    saving: () => pending.checked !== undefined,
    toggle: (checked: boolean) => {
      if (value() === checked) return Promise.resolve(true)
      setPending("checked", checked)
      return update(checked).then((ok) => {
        setPending("checked", undefined)
        return ok
      })
    },
  }
}
