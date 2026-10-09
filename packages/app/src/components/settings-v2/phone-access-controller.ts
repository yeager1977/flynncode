import { createSignal, onCleanup } from "solid-js"

type PhoneAccessApi = {
  getPhoneAccess?: () => Promise<boolean>
  setPhoneAccess?: (enabled: boolean) => Promise<void>
}

// The gateway starts or stops its phone routes live when the switch moves, but
// takes a moment to report it, so the status is refetched a few times after.
const REFETCH_DELAYS_MS = [500, 1500, 3000]

// Phone access is off by default: the gateway answers 404 on every phone route
// until the user turns it on. `enabled` is optimistic and rolls back if main
// refuses the change.
export function createPhoneAccessController(input: {
  api: PhoneAccessApi | undefined
  refetch: () => void
  delays?: number[]
}) {
  const [enabled, setEnabled] = createSignal(false)
  const timers = new Set<ReturnType<typeof setTimeout>>()
  let touched = false
  onCleanup(() => timers.forEach(clearTimeout))

  void input.api
    ?.getPhoneAccess?.()
    .then((stored) => {
      if (!touched) setEnabled(stored)
    })
    .catch(() => undefined)

  return {
    enabled,
    toggle(next: boolean) {
      if (!input.api?.setPhoneAccess) return
      touched = true
      setEnabled(next)
      void input.api.setPhoneAccess(next).then(
        () =>
          (input.delays ?? REFETCH_DELAYS_MS).forEach((delay) => {
            const timer = setTimeout(() => {
              timers.delete(timer)
              input.refetch()
            }, delay)
            timers.add(timer)
          }),
        () => setEnabled(!next),
      )
    },
  }
}
