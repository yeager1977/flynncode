import type { CommentElement } from "@/utils/comment-note"

export function reversePatch(patch: string) {
  const lines = patch.split("\n")
  const out: string[] = []
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? ""
    const next = lines[index + 1]
    if (line.startsWith("--- ") && next?.startsWith("+++ ")) {
      out.push(`--- ${next.slice(4)}`)
      out.push(`+++ ${line.slice(4)}`)
      index++
      continue
    }
    if (line.startsWith("@@")) {
      out.push(reverseHunkHeader(line))
      continue
    }
    if (line.startsWith("+")) {
      out.push(`-${line.slice(1)}`)
      continue
    }
    if (line.startsWith("-")) {
      out.push(`+${line.slice(1)}`)
      continue
    }
    out.push(line)
  }
  return out.join("\n")
}

// A browser annotation dispatched as a structured payload: the percent rect
// and capture screenshot travel as fields instead of a base64 string inside
 // the comment text.
export type BrowserScreenshotRect = { x: number; y: number; width: number; height: number }

export type BrowserAnnotationPayload = {
  file: string
  comment: string
  rect: BrowserScreenshotRect
  screenshot?: string
  // Element under the marked region when the native preview host inspected it.
  element?: CommentElement
}

// When a capture cannot persist as a draft-store blob, the legacy inline-
// thumbnail comment stays in the text, bounded by this character count.
export const BROWSER_SCREENSHOT_INLINE_LIMIT = 8000

export function inlineScreenshot(screenshot: string) {
  if (screenshot.length <= BROWSER_SCREENSHOT_INLINE_LIMIT) return screenshot
  return screenshot.slice(0, BROWSER_SCREENSHOT_INLINE_LIMIT)
}

// Shared composition for both degrade paths (web fallback and persistence
// failure), so their comment shapes never drift.
export function screenshotFallbackComment(comment: string, screenshot?: string) {
  if (!screenshot) return comment
  return `${comment} - ${inlineScreenshot(screenshot)}`
}

export function browserAnnotation(input: {
  url: string
  note: string
  x: number
  y: number
  width: number
  height: number
  path?: string
  // Accepted but ignored: the screenshot now flows through the structured
  // annotation payload, so a capture never lands in the comment text.
  thumbnail?: string
}) {
  const start = `${Math.round(input.x)}%,${Math.round(input.y)}%`
  const end = `${Math.round(input.x + input.width)}%,${Math.round(input.y + input.height)}%`
  const mark = input.width < 1 && input.height < 1 ? start : `${start}-${end}`
  return input.path ? `${input.path} - ${input.note} - ${mark}` : `${input.url} ${mark}: ${input.note}`
}

function reverseHunkHeader(line: string) {
  return line.replace(
    /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/,
    (_match, oldStart: string, oldLines: string | undefined, newStart: string, newLines: string | undefined) =>
      `@@ -${newStart}${newLines ? `,${newLines}` : ""} +${oldStart}${oldLines ? `,${oldLines}` : ""} @@`,
  )
}
