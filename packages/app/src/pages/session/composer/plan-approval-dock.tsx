import { Show, createSignal, onMount, type Component } from "solid-js"
import { useMutation } from "@tanstack/solid-query"
import { Button } from "@flynncode/ui/button"
import { DockPrompt } from "@flynncode/session-ui/dock-prompt"
import { Markdown } from "@flynncode/session-ui/markdown"
import type { QuestionRequest } from "@flynncode/sdk/v2"
import { showToast } from "@/utils/toast"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { planAnswer, type PlanChoice } from "@/context/plan-mode"

export const PlanApprovalDock: Component<{ request: QuestionRequest; plan: string; onSubmit: () => void }> = (
  props,
) => {
  const sdk = useSDK()
  const language = useLanguage()
  const [feedback, setFeedback] = createSignal("")
  let input: HTMLTextAreaElement | undefined

  const fail = (err: unknown) => {
    showToast({
      title: language.t("common.requestFailed"),
      description: err instanceof Error ? err.message : String(err),
    })
  }

  const replyMutation = useMutation(() => ({
    mutationFn: (choice: PlanChoice) =>
      sdk().api.question.reply({
        sessionID: props.request.sessionID,
        requestID: props.request.id,
        answers: planAnswer(choice, feedback()),
      }),
    onMutate: () => props.onSubmit(),
    onError: fail,
  }))

  // Dismissing is a "keep planning" answer on the server.
  const rejectMutation = useMutation(() => ({
    mutationFn: () => sdk().api.question.reject({ sessionID: props.request.sessionID, requestID: props.request.id }),
    onMutate: () => props.onSubmit(),
    onError: fail,
  }))

  const sending = () => replyMutation.isPending || rejectMutation.isPending
  const choose = (choice: PlanChoice) => {
    if (sending()) return
    replyMutation.mutate(choice)
  }

  onMount(() => input?.focus())

  return (
    <div data-component="plan-approval-dock">
      <DockPrompt
        kind="question"
        onKeyDown={(event) => {
          if (event.key !== "Escape" || event.defaultPrevented || sending()) return
          event.preventDefault()
          rejectMutation.mutate()
        }}
        header={<div data-slot="question-header-title">{language.t("session.plan.title")}</div>}
        footer={
          <>
            <Button
              variant="ghost"
              size="large"
              disabled={sending()}
              onClick={() => choose("keep")}
              data-action="plan-keep-planning"
            >
              {feedback().trim() ? language.t("session.plan.sendFeedback") : language.t("session.plan.keepPlanning")}
            </Button>
            <div data-slot="question-footer-actions">
              <Button
                variant="secondary"
                size="large"
                disabled={sending()}
                onClick={() => choose("manual")}
                data-action="plan-approve-manual"
              >
                {language.t("session.plan.approveManual")}
              </Button>
              <Button
                variant="primary"
                size="large"
                disabled={sending()}
                onClick={() => choose("accept-edits")}
                data-action="plan-approve-accept-edits"
              >
                {language.t("session.plan.approveAcceptEdits")}
              </Button>
            </div>
          </>
        }
      >
        <div data-slot="plan-approval-plan" class="max-h-[50dvh] overflow-y-auto px-2.5 py-1">
          <Show when={props.plan} fallback={<div data-slot="question-hint">{language.t("session.plan.empty")}</div>}>
            <Markdown text={props.plan} cacheKey={`plan-${props.request.id}`} />
          </Show>
        </div>
        <div class="px-2.5 pt-2">
          <textarea
            ref={input}
            data-slot="question-custom-input"
            class="w-full resize-none rounded-md border border-border-weak-base bg-background-base px-2 py-1.5 text-13-regular"
            rows={2}
            aria-label={language.t("session.plan.feedback.label")}
            placeholder={language.t("session.plan.feedback.placeholder")}
            value={feedback()}
            disabled={sending()}
            onInput={(event) => setFeedback(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.shiftKey || event.isComposing) return
              if (!feedback().trim()) return
              event.preventDefault()
              choose("keep")
            }}
          />
        </div>
      </DockPrompt>
    </div>
  )
}
