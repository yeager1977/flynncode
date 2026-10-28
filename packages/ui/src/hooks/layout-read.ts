import { batch } from "solid-js"

type Read = () => (() => void) | void

// Collects layout reads (scroll metrics, sizes) from several owners into one animation-frame phase: every read
// runs before any write, so a frame forces at most one layout instead of one per reader.
export function createLayoutReadPhase(request: (flush: () => void) => void) {
  const reads = new Map<unknown, Read>()
  const flush = () => {
    const batchReads = [...reads.values()]
    reads.clear()
    const writes = batchReads.map((read) => read())
    batch(() => writes.forEach((write) => write?.()))
  }
  return {
    schedule(owner: unknown, read: Read) {
      const idle = reads.size === 0
      reads.set(owner, read)
      if (idle) request(flush)
    },
    cancel(owner: unknown) {
      reads.delete(owner)
    },
  }
}

export const layoutReadPhase = createLayoutReadPhase((flush) => requestAnimationFrame(flush))
