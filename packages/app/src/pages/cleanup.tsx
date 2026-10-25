import { For, Show, createMemo, createSignal } from "solid-js"
import type { WorktreeCleanupReviewItem } from "@flynncode/sdk/v2/client"
import { Dialog } from "@flynncode/ui/dialog"
import { Button } from "@flynncode/ui/button"
import { useDialog } from "@flynncode/ui/context/dialog"
import { ButtonV2 } from "@flynncode/ui/v2/button-v2"
import { CheckboxV2 } from "@flynncode/ui/v2/checkbox-v2"
import { Tag } from "@flynncode/ui/v2/badge-v2"
import { TooltipV2 } from "@flynncode/ui/v2/tooltip-v2"
import { getFilename } from "@flynncode/core/util/path"
import { useLanguage } from "@/context/language"
import { formatBytes, groupByProject, useWorktreeCleanup } from "@/hooks/use-worktree-cleanup"
import { getRelativeTime } from "@/utils/time"
import { showToast } from "@/utils/toast"

// Items the server can remove: it refuses scan errors and worktrees holding a
// nested git repository, which a forced removal would destroy unseen.
export function selectable(item: WorktreeCleanupReviewItem) {
  return item.reason !== "error" && !item.nested?.length
}

// Everything a forced removal of the selected items deletes. Items that are
// not selectable land in `manual` and are never sent to the server.
export function selectionWarnings(items: WorktreeCleanupReviewItem[], selected: ReadonlySet<string>) {
  const chosen = items.filter((item) => selected.has(item.path))
  const removable = chosen.filter(selectable)
  return {
    removable: removable.map((item) => item.path),
    manual: chosen.filter((item) => !selectable(item)).map((item) => item.path),
    dirty: removable.reduce((sum, item) => sum + (item.dirty ?? 0), 0),
    unpushed: removable.reduce((sum, item) => sum + (item.unpushed ?? 0), 0),
    ignored: removable.reduce((sum, item) => sum + (item.ignored ?? 0), 0),
    ignoredExample: removable.find((item) => item.ignored && item.ignoredExample)?.ignoredExample,
    scratch: removable.filter((item) => item.reason === "scratch").length,
    rescued: removable.filter((item) => item.detached && item.unpushed).length,
  }
}

// Worktrees and folders the janitor will not delete on its own: select what to
// remove, review exactly what is lost, then confirm.
export function CleanupPage() {
  const language = useLanguage()
  const dialog = useDialog()
  const cleanup = useWorktreeCleanup()
  const [selected, setSelected] = createSignal<ReadonlySet<string>>(new Set<string>())
  const [scanning, setScanning] = createSignal(false)

  const report = () => cleanup.query.data
  const items = createMemo(() => report()?.items ?? [])
  const groups = createMemo(() => groupByProject(items()))
  const warnings = createMemo(() => selectionWarnings(items(), selected()))
  const busy = () => scanning() || !!report()?.scanning
  const reclaimable = createMemo(() => {
    const capped = items().some((item) => item.capped)
    return formatBytes(
      items().reduce((sum, item) => sum + item.bytes, 0),
      capped,
    )
  })
  const relative = (time: number) => getRelativeTime(new Date(time).toISOString(), language.t)

  const toggle = (path: string, value: boolean) =>
    setSelected((current) => {
      const next = new Set(current)
      if (value) next.add(path)
      else next.delete(path)
      return next
    })

  const scan = async () => {
    setScanning(true)
    const failed = await cleanup.scan().then(
      () => false,
      () => true,
    )
    setScanning(false)
    if (failed) showToast({ variant: "error", title: language.t("common.requestFailed") })
  }

  const removeSelected = async () => {
    const paths = warnings().removable
    const results = await cleanup.remove(paths).catch(() => undefined)
    if (!results) return showToast({ variant: "error", title: language.t("common.requestFailed") })
    setSelected(new Set<string>())
    const failures = results.filter((result) => !result.ok)
    const rescued = results.flatMap((result) => (result.rescued ? [result.rescued] : []))
    const removed = results.length - failures.length
    if (removed > 0 || failures.length === 0)
      showToast({
        variant: "success",
        title: language.t("cleanup.removed", { count: removed }),
        description: rescued.map((branch) => language.t("cleanup.rescued", { branch })).join("\n") || undefined,
      })
    if (failures.length > 0)
      showToast({
        variant: "error",
        title: language.t("cleanup.failed", {
          count: failures.length,
          reason: failures.map((failure) => `${getFilename(failure.path)}: ${failure.error ?? ""}`).join("; "),
        }),
      })
  }

  const confirmRemove = () => {
    const current = warnings()
    if (current.removable.length === 0) return
    const lines = [
      current.dirty > 0 && language.t("cleanup.confirm.dirty", { count: current.dirty }),
      current.ignored > 0 &&
        language.t("cleanup.confirm.ignored", { count: current.ignored, example: current.ignoredExample ?? "" }),
      current.unpushed > 0 && language.t("cleanup.confirm.unpushed", { count: current.unpushed }),
      current.rescued > 0 && language.t("cleanup.confirm.rescued"),
      current.scratch > 0 && language.t("cleanup.confirm.scratch", { count: current.scratch }),
      current.manual.length > 0 && language.t("cleanup.confirm.manual", { count: current.manual.length }),
    ].filter((line): line is string => !!line)
    dialog.show(() => (
      <Dialog title={language.t("cleanup.confirm.title", { count: current.removable.length })} fit>
        <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
          <ul data-component="cleanup-confirm-warnings" class="flex flex-col gap-1 list-disc pl-4">
            <For each={lines}>{(line) => <li class="text-14-regular text-text-strong">{line}</li>}</For>
          </ul>
          <div class="flex justify-end gap-2">
            <Button variant="ghost" size="large" onClick={() => dialog.close()}>
              {language.t("common.cancel")}
            </Button>
            <Button
              variant="primary"
              size="large"
              onClick={() => {
                dialog.close()
                void removeSelected()
              }}
            >
              {language.t("cleanup.confirm.button")}
            </Button>
          </div>
        </div>
      </Dialog>
    ))
  }

  return (
    <div class="flex flex-col gap-3 px-5 py-4 w-full max-w-[720px] overflow-y-auto">
      <div class="flex items-center justify-between gap-2 py-1">
        <div class="flex flex-col gap-0.5">
          <h1 class="text-17-medium text-v2-text-text-base">{language.t("cleanup.page.title")}</h1>
          <span class="text-12-regular text-v2-text-text-muted">
            <Show when={items().length > 0}>{language.t("cleanup.reclaimable", { size: reclaimable() })}</Show>
            <Show when={items().length > 0 && report()?.lastScan}>{" · "}</Show>
            <Show when={report()?.lastScan}>
              {(time) => language.t("cleanup.lastScan", { time: relative(time()) })}
            </Show>
          </span>
        </div>
        <div class="flex items-center gap-2">
          <ButtonV2 data-action="cleanup-scan" disabled={busy()} onClick={() => void scan()}>
            {busy() ? language.t("cleanup.scanning") : language.t("cleanup.scan")}
          </ButtonV2>
          <ButtonV2
            data-action="cleanup-remove"
            variant="danger"
            disabled={warnings().removable.length === 0}
            onClick={confirmRemove}
          >
            {language.t("cleanup.removeSelected")}
          </ButtonV2>
        </div>
      </div>
      <Show
        when={items().length > 0}
        fallback={
          <span class="self-center py-6 text-12-regular text-v2-text-text-faint">{language.t("cleanup.empty")}</span>
        }
      >
        <For each={groups()}>
          {(group) => (
            <section
              data-component="cleanup-project"
              class="flex flex-col gap-1.5 rounded-xl border border-v2-border-border-muted bg-v2-background-bg-base/40 p-3"
            >
              <div class="flex items-center justify-between gap-2">
                <TooltipV2 placement="top" value={group.project}>
                  <span class="text-13-medium text-v2-text-text-base">{getFilename(group.project)}</span>
                </TooltipV2>
                <span class="text-11-regular text-v2-text-text-faint">
                  {formatBytes(
                    group.bytes,
                    group.items.some((item) => item.capped),
                  )}
                </span>
              </div>
              <For each={group.items}>
                {(item) => (
                  <CleanupRow
                    item={item}
                    checked={selected().has(item.path)}
                    age={relative(item.lastActivity)}
                    onToggle={(value) => toggle(item.path, value)}
                  />
                )}
              </For>
            </section>
          )}
        </For>
      </Show>
      <Show when={(report()?.cleaned.length ?? 0) > 0}>
        <details data-component="cleanup-cleaned" class="rounded-xl border border-v2-border-border-muted p-3">
          <summary class="cursor-pointer text-13-medium text-v2-text-text-muted">
            {language.t("cleanup.cleaned.title")} ({report()?.cleaned.length})
          </summary>
          <div class="flex flex-col gap-1 pt-2">
            <For each={report()?.cleaned}>
              {(entry) => (
                <div class="flex items-center justify-between gap-2 text-12-regular text-v2-text-text-muted">
                  <TooltipV2 placement="top" value={entry.path}>
                    <span class="truncate">{getFilename(entry.path)}</span>
                  </TooltipV2>
                  <span class="shrink-0 text-v2-text-text-faint">
                    {formatBytes(entry.bytes, false)} · {relative(entry.time)}
                  </span>
                </div>
              )}
            </For>
          </div>
        </details>
      </Show>
    </div>
  )
}

function CleanupRow(props: {
  item: WorktreeCleanupReviewItem
  checked: boolean
  age: string
  onToggle: (value: boolean) => void
}) {
  const language = useLanguage()
  const blocked = () => !selectable(props.item)
  const detail = () => (props.item.nested?.length ? language.t("cleanup.nested") : props.item.detail)
  return (
    <div data-component="cleanup-item" data-path={props.item.path} class="flex items-start gap-2">
      <CheckboxV2
        checked={props.checked}
        disabled={blocked()}
        onChange={props.onToggle}
        hideLabel
        label={getFilename(props.item.path)}
      />
      <div class="flex min-w-0 flex-1 flex-col gap-0.5">
        <div class="flex items-center justify-between gap-2">
          <TooltipV2 placement="top" value={props.item.path}>
            <span class="truncate text-13-regular text-v2-text-text-base">{getFilename(props.item.path)}</span>
          </TooltipV2>
          <span class="shrink-0 text-12-regular text-v2-text-text-muted">
            {formatBytes(props.item.bytes, props.item.capped)}
          </span>
        </div>
        <div class="flex items-center gap-2 text-11-regular text-v2-text-text-faint">
          <Tag variant={props.item.reason === "error" ? "accent" : "neutral"}>
            {language.t(`cleanup.reason.${props.item.reason}`)}
          </Tag>
          <Show when={props.item.branch}>{(branch) => <span class="truncate">{branch()}</span>}</Show>
          <span class="shrink-0">{props.age}</span>
        </div>
        <Show when={detail()}>
          <span class="text-11-regular text-v2-text-text-muted" title={detail()}>
            {detail()}
          </span>
        </Show>
      </div>
    </div>
  )
}
