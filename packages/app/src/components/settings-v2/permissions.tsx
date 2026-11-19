import { useDialog } from "@flynncode/ui/context/dialog"
import { ButtonV2 } from "@flynncode/ui/v2/button-v2"
import { Dialog, DialogFooter, DialogHeader, DialogTitleGroup } from "@flynncode/ui/v2/dialog-v2"
import { DividerV2 } from "@flynncode/ui/v2/divider-v2"
import { SelectV2 } from "@flynncode/ui/v2/select-v2"
import { For, Show, createMemo, type Component } from "solid-js"
import { createStore } from "solid-js/store"
import type { ApprovalMode, Config, PermissionActionConfig, SandboxMode } from "@flynncode/sdk/v2/client"
import { useLanguage } from "@/context/language"
import { useServerSync } from "@/context/server-sync"
import { showToast } from "@/utils/toast"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import "./settings-v2.css"

type Actions = { [key: string]: PermissionActionConfig | undefined }
type Policy = { approval: ApprovalMode; sandbox: SandboxMode; actions: Actions }

const approvalOptions: Array<Policy["approval"]> = ["manual", "accept-edits", "auto"]

// Action permissions the panel edits: single ask/allow/deny decisions, not
// pattern maps like read/edit/bash. An unset key writes nothing, leaving the
// server's built-in defaults (worktree prompts, for example).
const actionPermissions = [
  "worktree",
  "worktree_discard",
  "archive",
  "question",
  "webfetch",
  "websearch",
  "doom_loop",
  "github-triage",
  "github-pr-search",
] as const

// The visible sandbox levels; full-access activates only through the explicit
// danger confirmation below, never silently through the select.
const sandboxChoices: Array<Exclude<Policy["sandbox"], "full-access">> = ["readonly", "workspace-write"]

function actionValue(value: unknown): PermissionActionConfig | undefined {
  if (value === "ask" || value === "allow" || value === "deny") return value
  return undefined
}

export function policyFromConfig(config: Config | undefined): Policy {
  const permission = config?.permission
  // Intentional materialization: a bare-string permission ("allow") carries no
  // explicit session policy, so the UI shows the server's decode defaults —
  // sandbox "workspace-write" mirrors ConfigPermissionV1.SessionPolicy's
  // decoding default (packages/core/src/v1/config/permission.ts). Saving writes
  // those values back verbatim, so the UI's policy always equals what the
  // server resolves for every session.
  if (typeof permission !== "object") return { approval: "manual", sandbox: "workspace-write", actions: {} }
  const record = permission as Record<string, unknown>
  const actions: Actions = {}
  for (const key of actionPermissions) actions[key] = actionValue(record[key])
  return {
    approval: approvalLevel(record.approval as ApprovalMode | undefined),
    sandbox: sandboxLevel(record.sandbox as SandboxMode | undefined),
    actions,
  }
}

function approvalLevel(value: ApprovalMode | undefined): ApprovalMode {
  if (value === "manual" || value === "accept-edits" || value === "auto") return value
  return "manual"
}

function sandboxLevel(value: SandboxMode | undefined): SandboxMode {
  if (value === "readonly" || value === "workspace-write" || value === "full-access") return value
  return "workspace-write"
}

// Config permission may be a bare action string ("allow"); converting it to the
// equivalent `"*"` rule keeps the catch-all when policy keys are added. The
// server replaces `permission` as a whole subtree at write sites, so the patch
// carries the full current value — unrelated sibling keys never drop. An unset
// action key is deleted so a value saved earlier can return to the built-in
// default without pinning "ask" forever.
export function policyToConfig(current: Config["permission"], policy: Policy): NonNullable<Config["permission"]> {
  const base = (typeof current === "string" ? { "*": current } : { ...current }) as Record<string, unknown>
  for (const key of actionPermissions) {
    if (policy.actions[key]) base[key] = policy.actions[key]
    else delete base[key]
  }
  return { ...base, approval: policy.approval, sandbox: policy.sandbox } as NonNullable<Config["permission"]>
}

export const SettingsPermissionsV2: Component = () => {
  const language = useLanguage()
  const dialog = useDialog()
  const serverSync = useServerSync()
  const [state, setState] = createStore({ saving: false })

  const policy = createMemo(() => policyFromConfig(serverSync().data.config))

  const samePolicy = (a: Policy, b: Policy) => {
    if (a.approval !== b.approval || a.sandbox !== b.sandbox) return false
    if (!Object.is(Object.keys(a.actions).length, Object.keys(b.actions).length)) return false
    return actionPermissions.every((key) => a.actions[key] === b.actions[key])
  }

  const save = async (target: Policy) => {
    if (state.saving) return
    // Selecting the already-active value (e.g. the full-access entry shown in
    // the select while it is enabled) is a no-op, not a re-write.
    const current = policy()
    if (samePolicy(current, target)) return
    setState("saving", true)
    const ok = await serverSync()
      .updateConfig({ permission: policyToConfig(serverSync().data.config.permission, target) })
      .then(() => true)
      .catch(() => false)
    setState("saving", false)
    if (ok) return
    showToast({ variant: "error", title: language.t("settings.permissions.toast.updateFailed.title") })
  }

  const saveApproval = (approval: ApprovalMode) =>
    void save({ approval, sandbox: policy().sandbox, actions: policy().actions })
  const saveSandbox = (sandbox: SandboxMode) =>
    void save({ approval: policy().approval, sandbox, actions: policy().actions })
  const saveAction = (key: string, value: PermissionActionConfig | undefined) =>
    void save({ approval: policy().approval, sandbox: policy().sandbox, actions: { ...policy().actions, [key]: value } })

  const confirmFullAccess = () => {
    void dialog.push(() => (
      <Dialog fit>
        <DialogHeader>
          <DialogTitleGroup
            title={language.t("settings.permissions.fullAccess.confirm.title")}
            description={language.t("settings.permissions.fullAccess.confirm.body")}
          />
        </DialogHeader>
        <DividerV2 />
        <DialogFooter>
          <ButtonV2 variant="neutral" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </ButtonV2>
          <ButtonV2
            variant="danger"
            onClick={() => {
              dialog.close()
              saveSandbox("full-access")
            }}
          >
            {language.t("settings.permissions.fullAccess.confirm.accept")}
          </ButtonV2>
        </DialogFooter>
      </Dialog>
    ))
  }

  const actionChoices = ["unset", "ask", "allow", "deny"]

  // "ask"/"allow"/"deny" reuse the existing action keys; only "unset" is new.
  const actionChoiceLabel = (choice: string) =>
    choice === "unset"
      ? language.t("settings.permissions.action.unset")
      : language.t(`settings.permissions.action.${choice}`)

  const actionLabelKey = (permission: (typeof actionPermissions)[number], part: "label" | "description") =>
    `settings.permissions.tool.${permission}.${part}`

  const sandboxOptions = createMemo<Policy["sandbox"][]>(() =>
    policy().sandbox === "full-access" ? [...sandboxChoices, "full-access"] : sandboxChoices,
  )

  const approvalLabel = (choice: Policy["approval"]) => {
    if (choice === "manual") return language.t("settings.permissions.approval.manual")
    if (choice === "accept-edits") return language.t("settings.permissions.approval.acceptEdits")
    return language.t("settings.permissions.approval.auto")
  }

  const sandboxLabel = (choice: Policy["sandbox"]) => {
    if (choice === "readonly") return language.t("settings.permissions.sandbox.readonly")
    if (choice === "workspace-write") return language.t("settings.permissions.sandbox.workspace")
    return language.t("settings.permissions.sandbox.fullAccess")
  }

  return (
    <>
      <div class="settings-v2-tab-header">
        <h2 class="settings-v2-tab-title">{language.t("settings.permissions.title")}</h2>
      </div>
      <div class="settings-v2-tab-body flex flex-col gap-4">
        <p class="text-text-weak">{language.t("settings.permissions.description")}</p>
        <SettingsListV2>
          <SettingsRowV2
            title={language.t("settings.permissions.approval.label")}
            description={language.t("settings.permissions.approval.description")}
          >
            <SelectV2
              appearance="inline"
              data-action="settings-approval"
              disabled={state.saving}
              options={approvalOptions}
              current={policy().approval}
              placement="bottom-end"
              gutter={6}
              label={approvalLabel}
              onSelect={(choice) => choice !== null && saveApproval(choice)}
            />
          </SettingsRowV2>
          <SettingsRowV2
            title={language.t("settings.permissions.sandbox.label")}
            description={language.t("settings.permissions.sandbox.description")}
          >
            <SelectV2
              appearance="inline"
              data-action="settings-sandbox"
              disabled={state.saving}
              options={sandboxOptions()}
              current={policy().sandbox}
              placement="bottom-end"
              gutter={6}
              label={sandboxLabel}
              onSelect={(choice) => choice !== null && saveSandbox(choice)}
            />
          </SettingsRowV2>
          <SettingsRowV2
            title={language.t("settings.permissions.fullAccess.button")}
            description={language.t("settings.permissions.fullAccess.description")}
          >
            <ButtonV2
              variant="danger"
              disabled={state.saving || policy().sandbox === "full-access"}
              onClick={confirmFullAccess}
            >
              {language.t("settings.permissions.fullAccess.button")}
            </ButtonV2>
          </SettingsRowV2>
        </SettingsListV2>
        <SettingsListV2>
          <For each={actionPermissions}>
            {(permission) => (
              <SettingsRowV2
              title={language.t(actionLabelKey(permission, "label"))}
              description={language.t(actionLabelKey(permission, "description"))}
            >
              <SelectV2
                appearance="inline"
                data-action={`settings-permission-${permission}`}
                disabled={state.saving}
                options={actionChoices}
                current={policy().actions[permission] ?? "unset"}
                placement="bottom-end"
                gutter={6}
                label={actionChoiceLabel}
                onSelect={(choice) =>
                  choice !== null &&
                  saveAction(permission, choice === "unset" ? undefined : (choice as PermissionActionConfig))
                }
              />
            </SettingsRowV2>
            )}
          </For>
        </SettingsListV2>
        <Show when={policy().approval === "auto"}>
          <p class="text-text-weak">{language.t("settings.permissions.approval.auto.description")}</p>
        </Show>
      </div>
    </>
  )
}