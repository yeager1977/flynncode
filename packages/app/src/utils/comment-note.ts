import type { FileSelection } from "@/context/file"

export type PromptComment = {
  path: string
  selection?: FileSelection
  comment: string
  preview?: string
  origin?: "review" | "file"
  element?: CommentElement
}

// Element under the annotated region, captured from the native preview host.
export type CommentElement = {
  tag: string
  id?: string
  classes?: string
  text?: string
  rect: { x: number; y: number; width: number; height: number }
}

export type CommentRect = { x: number; y: number; width: number; height: number }

function selection(selection: unknown) {
  if (!selection || typeof selection !== "object") return undefined
  const startLine = Number((selection as FileSelection).startLine)
  const startChar = Number((selection as FileSelection).startChar)
  const endLine = Number((selection as FileSelection).endLine)
  const endChar = Number((selection as FileSelection).endChar)
  if (![startLine, startChar, endLine, endChar].every(Number.isFinite)) return undefined
  return {
    startLine,
    startChar,
    endLine,
    endChar,
  } satisfies FileSelection
}

function rect(value: unknown) {
  if (!value || typeof value !== "object") return undefined
  const raw = value as Record<string, unknown>
  // Strict numeric bounds: coercion would accept string coordinates the
  // main-side sanitizer would already have refused.
  const bounds = [raw.x, raw.y, raw.width, raw.height]
  if (!bounds.every((bound): bound is number => typeof bound === "number" && Number.isFinite(bound))) return undefined
  const [x, y, width, height] = bounds
  return { x, y, width, height } satisfies CommentRect
}

function element(value: unknown) {
  if (!value || typeof value !== "object") return undefined
  const raw = value as Record<string, unknown>
  const bounds = rect(raw.rect)
  const tag = typeof raw.tag === "string" ? raw.tag : ""
  if (!tag || !bounds) return undefined
  const id = typeof raw.id === "string" ? raw.id : undefined
  const classes = typeof raw.classes === "string" ? raw.classes : undefined
  const text = typeof raw.text === "string" ? raw.text : undefined
  return {
    tag,
    rect: bounds,
    ...(id ? { id } : {}),
    ...(classes ? { classes } : {}),
    ...(text ? { text } : {}),
  } satisfies CommentElement
}

export function createCommentMetadata(input: PromptComment) {
  return {
    opencodeComment: {
      path: input.path,
      selection: input.selection,
      comment: input.comment,
      preview: input.preview,
      origin: input.origin,
      ...(input.element ? { element: input.element } : {}),
    },
  }
}

export function readCommentMetadata(value: unknown) {
  if (!value || typeof value !== "object") return
  const meta = (value as { opencodeComment?: unknown }).opencodeComment
  if (!meta || typeof meta !== "object") return
  const path = (meta as { path?: unknown }).path
  const comment = (meta as { comment?: unknown }).comment
  if (typeof path !== "string" || typeof comment !== "string") return
  const preview = (meta as { preview?: unknown }).preview
  const origin = (meta as { origin?: unknown }).origin
  return {
    path,
    selection: selection((meta as { selection?: unknown }).selection),
    comment,
    preview: typeof preview === "string" ? preview : undefined,
    origin: origin === "review" || origin === "file" ? origin : undefined,
    element: element((meta as { element?: unknown }).element),
  } satisfies PromptComment
}

// Model-facing descriptor appended after the path: compact identity of the
// element the annotation landed on (tag, optional id, optional quoted text).
function elementDescriptor(value?: CommentElement) {
  if (!value) return undefined
  return [value.tag.toLowerCase(), value.id ? `#${value.id}` : undefined, value.text ? `"${value.text}"` : undefined]
    .filter((part): part is string => part !== undefined)
    .join(" ")
}

export function formatCommentNote(input: { path: string; selection?: FileSelection; comment: string; element?: CommentElement }) {
  const start = input.selection ? Math.min(input.selection.startLine, input.selection.endLine) : undefined
  const end = input.selection ? Math.max(input.selection.startLine, input.selection.endLine) : undefined
  const range =
    start === undefined || end === undefined
      ? "this file"
      : start === end
        ? `line ${start}`
        : `lines ${start} through ${end}`
  const descriptor = elementDescriptor(input.element)
  return `The user made the following comment regarding ${range} of ${input.path}${descriptor ? ` (${descriptor})` : ""}: ${input.comment}`
}

export function parseCommentNote(text: string) {
  const match = text.match(
    /^The user made the following comment regarding (this file|line (\d+)|lines (\d+) through (\d+)) of (.+?): ([\s\S]+)$/,
  )
  if (!match) return
  const start = match[2] ? Number(match[2]) : match[3] ? Number(match[3]) : undefined
  const end = match[2] ? Number(match[2]) : match[4] ? Number(match[4]) : undefined
  return {
    path: match[5],
    selection:
      start !== undefined && end !== undefined
        ? {
            startLine: start,
            startChar: 0,
            endLine: end,
            endChar: 0,
          }
        : undefined,
    comment: match[6],
  } satisfies PromptComment
}
