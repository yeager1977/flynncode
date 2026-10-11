import type { createPromptState, ImageAttachmentPart } from "@/context/prompt-state"
import type { DraftStore } from "@/utils/draft-store"
import { uuid } from "@/utils/uuid"
import { screenshotFallbackComment, type BrowserAnnotationPayload } from "./hunk-revert"

type PromptTarget = ReturnType<ReturnType<typeof createPromptState>["capture"]>

export function captureReviewAnnotation(input: {
  prompt: () => PromptTarget
  capture: () => Promise<BrowserAnnotationPayload>
  deliver: (payload: BrowserAnnotationPayload) => void
}) {
  const target = input.prompt()
  const owner = target.attachmentScope()
  const work = input.capture().then(payload => {
    if (!owner.valid() || input.prompt() !== target) return false
    input.deliver(payload)
    return true
  })
  owner.track(work)
  return work
}

export function attachReviewScreenshot(input: {
  prompt: () => PromptTarget
  draftStore: DraftStore
  screenshot: string
  file: string
  id: string
  comment: string
  updateComment: (comment: string) => void
}) {
  const target = input.prompt()
  const owner = target.attachmentScope()
  const work = fetch(input.screenshot).then(response => response.blob()).then(async blob => {
    if (!owner.valid()) return
    const reference = await input.draftStore.putBlob(blob)
    const attachment: ImageAttachmentPart = {
      type: "image", id: uuid(), filename: "browser-annotate.png",
      mime: dataUrlMime(input.screenshot), blob: reference,
    }
    if (!owner.append(attachment)) await input.draftStore.discardBlob(reference)
  }).catch(() => {
    console.debug("[session] browser annotation screenshot persistence failed")
    if (!owner.valid()) return
    const comment = screenshotFallbackComment(input.comment, input.screenshot)
    input.updateComment(comment)
    target.context.updateComment(input.file, input.id, { comment })
  })
  owner.track(work)
  return work
}

function dataUrlMime(dataUrl: string) {
  if (!dataUrl.startsWith("data:")) return "image/png"
  const end = dataUrl.indexOf(";")
  if (end === -1) return "image/png"
  return dataUrl.slice(5, end) || "image/png"
}
