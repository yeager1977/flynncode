import { For, Show } from "solid-js"
import type { PermissionRequest } from "@opencode-ai/sdk/v2"
import { Button } from "@opencode-ai/ui/button"
import { DockPrompt } from "@opencode-ai/session-ui/dock-prompt"
import { Icon } from "@opencode-ai/ui/icon"
import { useLanguage } from "@/context/language"
import type { ApprovalMode, SandboxLevel } from "@/context/permission"

const SANDBOX_BADGE_KEY: Record<
  SandboxLevel,
  "sandbox.badge.readonly" | "sandbox.badge.workspace" | "sandbox.badge.full"
> = {
  readonly: "sandbox.badge.readonly",
  "workspace-write": "sandbox.badge.workspace",
  "full-access": "sandbox.badge.full",
}

const APPROVAL_MODE_KEY: Record<
  ApprovalMode,
  "approval.mode.manual" | "approval.mode.acceptEdits" | "approval.mode.auto"
> = {
  manual: "approval.mode.manual",
  "accept-edits": "approval.mode.acceptEdits",
  auto: "approval.mode.auto",
}

function nextMode(mode: ApprovalMode): ApprovalMode {
  if (mode === "manual") return "accept-edits"
  if (mode === "accept-edits") return "auto"
  return "manual"
}

export function SessionPermissionDock(props: {
  request: PermissionRequest
  responding: boolean
  onDecide: (response: "once" | "always" | "reject") => void
  sandbox?: SandboxLevel
  approvalMode?: ApprovalMode
  blockedBySandbox?: boolean
  reviewerApproved?: boolean
  onModeChange?: (mode: ApprovalMode) => void
}) {
  const language = useLanguage()

  const sandbox = () => props.sandbox ?? "workspace-write"
  const approvalMode = () => props.approvalMode ?? "manual"

  const toolDescription = () => {
    const key = `settings.permissions.tool.${props.request.permission}.description`
    const value = language.t(key as Parameters<typeof language.t>[0])
    if (value === key) return ""
    return value
  }

  return (
    <DockPrompt
      kind="permission"
      header={
        <div data-slot="permission-row" data-variant="header">
          <span data-slot="permission-icon">
            <Icon name="warning" size="normal" />
          </span>
          <div data-slot="permission-header-title">{language.t("notification.permission.title")}</div>
        </div>
      }
      footer={
        <>
          <div />
          <div data-slot="permission-footer-actions">
            <Show when={props.blockedBySandbox !== true}>
              <Button
                variant="ghost"
                size="normal"
                onClick={() => props.onDecide("reject")}
                disabled={props.responding}
              >
                {language.t("ui.permission.deny")}
              </Button>
              <Show when={props.request.permission !== "computer_use"}>
                <Button
                  variant="secondary"
                  size="normal"
                  onClick={() => props.onDecide("always")}
                  disabled={props.responding}
                >
                  {language.t("ui.permission.allowAlways")}
                </Button>
              </Show>
              <Button
                variant="primary"
                size="normal"
                onClick={() => props.onDecide("once")}
                disabled={props.responding}
              >
                {language.t("ui.permission.allowOnce")}
              </Button>
            </Show>
            <Button
              variant="ghost"
              size="normal"
              onClick={() => props.onModeChange?.(nextMode(approvalMode()))}
              disabled={props.responding}
            >
              {language.t(APPROVAL_MODE_KEY[approvalMode()])}
            </Button>
          </div>
        </>
      }
    >
      <div data-slot="permission-row">
        <span data-slot="permission-spacer" aria-hidden="true" />
        <div data-slot="sandbox-badge">{language.t(SANDBOX_BADGE_KEY[sandbox()])}</div>
      </div>

      <Show
        when={props.blockedBySandbox === true}
        fallback={
          <Show when={toolDescription()}>
            <div data-slot="permission-row">
              <span data-slot="permission-spacer" aria-hidden="true" />
              <div data-slot="permission-hint">{toolDescription()}</div>
            </div>
          </Show>
        }
      >
        <div data-slot="permission-row">
          <span data-slot="permission-spacer" aria-hidden="true" />
          <div data-slot="permission-hint">{language.t("approval.sandboxBlocked.title")}</div>
        </div>
        <div data-slot="permission-row">
          <span data-slot="permission-spacer" aria-hidden="true" />
          <div data-slot="permission-hint">{language.t("approval.sandboxBlocked.description")}</div>
        </div>
      </Show>

      <Show when={props.request.patterns.length > 0}>
        <div data-slot="permission-row">
          <span data-slot="permission-spacer" aria-hidden="true" />
          <div data-slot="permission-patterns">
            <For each={props.request.patterns}>
              {(pattern) => <code class="text-12-regular text-text-base break-all">{pattern}</code>}
            </For>
          </div>
        </div>
      </Show>

      <Show when={props.reviewerApproved === true}>
        <div data-slot="permission-row">
          <span data-slot="permission-spacer" aria-hidden="true" />
          <div data-slot="permission-hint">{language.t("approval.reviewerDeferred.note")}</div>
        </div>
      </Show>

      <Show when={props.request.permission === "computer_use"}>
        <div data-slot="permission-row">
          <span data-slot="permission-spacer" aria-hidden="true" />
          <div data-slot="permission-hint">{language.t("computerUse.consent.title")}</div>
        </div>
        <div data-slot="permission-row">
          <span data-slot="permission-spacer" aria-hidden="true" />
          <div data-slot="permission-hint">{language.t("computerUse.consent.note")}</div>
        </div>
      </Show>
    </DockPrompt>
  )
}
