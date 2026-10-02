import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Show } from "solid-js"
import { useLanguage } from "@/context/language"
import type { BulkOp } from "./session-bulk-run"

export function BulkConfirmDialog(props: {
  op: BulkOp
  count: number
  matchLabel?: string
  skippedLabel?: string
  empty?: boolean
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
  onArchive?: () => void
  onDelete?: () => void
}) {
  const language = useLanguage()
  const dual = () => !!props.onArchive && !!props.onDelete
  const title = () => {
    if (props.empty || dual()) return language.t("session.bulk.cleanup")
    if (props.op === "delete") return language.t("session.bulk.delete")
    return language.t("session.bulk.archive")
  }
  const confirm = () =>
    props.op === "delete"
      ? language.plural("session.bulk.delete.confirm", props.count)
      : language.plural("session.bulk.archive.confirm", props.count)

  return (
    <Dialog title={title()} fit>
      <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
        <Show when={props.matchLabel}>
          <span class="text-14-regular text-text-strong">{props.matchLabel}</span>
        </Show>
        <Show when={props.skippedLabel}>
          <span class="text-12-regular text-text-weak">{props.skippedLabel}</span>
        </Show>
        <Show
          when={props.empty}
          fallback={
            <Show when={!dual()}>
              <span class="text-14-regular text-text-strong">{confirm()}</span>
            </Show>
          }
        >
          <span class="text-14-regular text-text-strong">{language.t("session.bulk.cleanup.empty")}</span>
        </Show>
        <div class="flex justify-end gap-2">
          <Button variant="ghost" size="large" disabled={props.busy} onClick={props.onCancel}>
            {language.t("session.bulk.cancel")}
          </Button>
          <Show when={!props.empty && !dual()}>
            <Button variant="primary" size="large" disabled={props.busy || props.count === 0} onClick={props.onConfirm}>
              {title()}
            </Button>
          </Show>
          <Show when={!props.empty && dual()}>
            <Button
              variant="ghost"
              size="large"
              disabled={props.busy || props.count === 0}
              onClick={() => props.onArchive?.()}
            >
              {language.t("session.bulk.archive")}
            </Button>
            <Button
              variant="primary"
              size="large"
              disabled={props.busy || props.count === 0}
              onClick={() => props.onDelete?.()}
            >
              {language.t("session.bulk.delete")}
            </Button>
          </Show>
        </div>
      </div>
    </Dialog>
  )
}
