import { describe, expect, test } from "bun:test"
import { createCommentMetadata, formatCommentNote, parseCommentNote, readCommentMetadata, type CommentElement } from "./comment-note"

const element: CommentElement = {
  tag: "BUTTON",
  text: "Save file",
  rect: { x: 10, y: 20, width: 80, height: 30 },
}

const base = {
  path: "preview",
  selection: { startLine: 1, startChar: 0, endLine: 1, endChar: 0 },
  comment: "too cramped",
}

describe("formatCommentNote", () => {
  test("appends an element descriptor when element metadata is present", () => {
    const note = formatCommentNote({ ...base, element })
    expect(note).toContain('(button "Save file")')
  })

  test("appends the element id to the descriptor when present", () => {
    const note = formatCommentNote({ ...base, element: { ...element, id: "save" } })
    expect(note).toContain('(button #save "Save file")')
  })

  test("leaves the note text unchanged without element metadata", () => {
    const note = formatCommentNote(base)
    expect(note).not.toContain("button")
    expect(note).toBe("The user made the following comment regarding line 1 of preview: too cramped")
  })
})

describe("createCommentMetadata", () => {
  test("carries element metadata when present", () => {
    const meta = createCommentMetadata({ ...base, element })
    expect(meta.opencodeComment.element).toEqual(element)
  })

  test("omits the element key when element is absent", () => {
    const meta = createCommentMetadata(base)
    expect("element" in meta.opencodeComment).toBe(false)
  })
})

describe("readCommentMetadata", () => {
  test("round-trips valid element metadata", () => {
    const meta = createCommentMetadata({ ...base, element })
    const parsed = readCommentMetadata(meta)
    expect(parsed?.element).toEqual(element)
  })

  test("drops element metadata with a malformed rect", () => {
    const parsed = readCommentMetadata({
      opencodeComment: {
        path: "preview",
        comment: "too cramped",
        element: { tag: "BUTTON", text: "Save file", rect: { x: "10", y: 20, width: 80, height: 30 } },
      },
    })
    expect(parsed?.element).toBeUndefined()
    expect(parsed?.comment).toBe("too cramped")
  })
})

describe("parseCommentNote", () => {
  test("strips the trailing element descriptor from the path when metadata is missing", () => {
    const note = formatCommentNote({ ...base, element })
    const parsed = parseCommentNote(note)
    expect(parsed?.path).toBe("preview")
    expect(parsed?.comment).toBe("too cramped")
    expect(parsed?.selection).toEqual(base.selection)
  })

  // Documented limitation (see CommentElement): descriptor text containing
  // `": "` splits the note at the wrong colon, so the parse degrades. This
  // test pins the current behavior.
  test("degrades when element text contains a colon-space", () => {
    const note = formatCommentNote({ ...base, element: { ...element, text: 'Save: file' } })
    const parsed = parseCommentNote(note)
    expect(parsed?.path).toBe('preview (button "Save')
    expect(parsed?.comment).toBe('file"): too cramped')
  })
})