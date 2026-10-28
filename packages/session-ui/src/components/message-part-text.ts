import { createMemo, createRoot, getListener, type Accessor } from "solid-js"
import { $RAW } from "solid-js/store"

export function readPartText(accum: Record<string, string> | undefined, part: { id: string; text?: string }): string {
  return (accum?.[part.id] ?? part.text ?? "").trim()
}

const nonEmpty = new WeakMap<object, Accessor<boolean>>()

// Whether a part has non-whitespace text. Inside a reactive scope a store part gets one cached memo,
// so a streamed delta notifies callers only when the part turns empty or non-empty. The memo lives
// as long as the part (detached root, weakly keyed), so it does not depend on the caller's lifetime.
export function hasPartText(part: { text?: string }): boolean {
  const cached = nonEmpty.get(part)
  if (cached) return cached()
  if (!getListener() || !(part as { [$RAW]?: unknown })[$RAW]) return /\S/.test(part.text ?? "")
  const memo = createRoot(() => createMemo(() => /\S/.test(part.text ?? "")))
  nonEmpty.set(part, memo)
  return memo()
}
