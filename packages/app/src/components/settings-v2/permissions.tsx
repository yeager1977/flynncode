import { useDialog } from "@flynncode/ui/context/dialog"
import { ButtonV2 } from "@flynncode/ui/v2/button-v2"
import { Dialog, DialogFooter, DialogHeader, DialogTitleGroup } from "@flynncode/ui/v2/dialog-v2"
import { DividerV2 } from "@flynncode/ui/v2/divider-v2"
import { SelectV2 } from "@flynncode/ui/v2/select-v2"
import { Show, createMemo, type Component } from "solid-js"
import { createStore } from "solid-js/store"
import type { ApprovalMode, Config, SandboxMode } from "@flynncode/sdk/v2/client"
import { useLanguage } from "@/context/language"
import { useServerSync } from "@/context/server-sync"
import { showToast } from "@/utils/toast"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import "./settings-v2.css"

type Policy = { approval: ApprovalMode; sandbox: SandboxMode }

const approvalOptions: Array<Policy["approval"]> = ["manual", "accept-edits", "auto"]

// The visible sandbox levels; full-access activates only through the explicit
// danger confirmation below, never silently through the select.
const sandboxChoices: Array<Exclude<Policy["sandbox"], "full-access">> = ["readonly", "workspace-write"]

export function policyFromConfig(config: Config | undefined): Policy {
  const permission = config?.permission
  // Intentional materialization: a bare-string permission ("allow") carries no
  // explicit session policy, so the UI shows the server's decode defaults —
  // sandbox "workspace-write" mirrors ConfigPermissionV1.SessionPolicy's
  // decoding default (packages/core/src/v1/config/permission.ts). Saving writes
  // those values back verbatim, so the UI's policy always equals what the
  // server resolves for every session.
  if (typeof permission !== "object") return { approval: "manual", sandbox: "workspace-write" }
  return { approval: approvalLevel(permission.approval), sandbox: sandboxLevel(permission.sandbox) }
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
// carries the full current value — unrelated sibling keys never drop.
export function policyToConfig(current: Config["permission"], policy: Policy): NonNullable<Config["permission"]> {
  const base = typeof current === "string" ? { "*": current } : { ...current }
  return { ...base, approval: policy.approval, sandbox: policy.sandbox }
}

export const SettingsPermissionsV2: Component = () => {
  const language = useLanguage()
  const dialog = useDialog()
  const serverSync = useServerSync()
  const [state, setState] = createStore({ saving: false })

  const policy = createMemo(() => policyFromConfig(serverSync().data.config))

  const save = async (target: Policy) => {
    if (state.saving) return
    // Selecting the already-active value (e.g. the full-access entry shown in
    // the select while it is enabled) is a no-op, not a re-write.
    const current = policy()
    if (current.approval === target.approval && current.sandbox === target.sandbox) return
    setState("saving", true)
    const ok = await serverSync()
      .updateConfig({ permission: policyToConfig(serverSync().data.config.permission, target) })
      .then(() => true)
      .catch(() => false)
    setState("saving", false)
    if (ok) return
    showToast({ variant: "error", title: language.t("settings.permissions.toast.updateFailed.title") })
  }

  const saveApproval = (approval: ApprovalMode) => void save({ approval, sandbox: policy().sandbox })
  const saveSandbox = (sandbox: SandboxMode) => void save({ approval: policy().approval, sandbox })

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
        <Show when={policy().approval === "auto"}>
          <p class="text-text-weak">{language.t("settings.permissions.approval.auto.description")}</p>
        </Show>
      </div>
    </>
  )
}