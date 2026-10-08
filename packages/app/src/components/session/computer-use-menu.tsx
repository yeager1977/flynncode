import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { Popover } from "@opencode-ai/ui/popover"
import { Switch } from "@opencode-ai/ui/switch"
import { TextField } from "@opencode-ai/ui/text-field"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { createMemo, createSignal, For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { useServerSync } from "@/context/server-sync"
import { showToast } from "@/utils/toast"

// The desktop main process reads this key to gate client-side execution; keep it in
// step with `computer_use.allowedApps`, which the server tool checks.
const COMPUTER_USE_STORE = "opencode.settings"
const COMPUTER_USE_KEY = "computerUseAllowedApps"

// `v2` renders the trigger like the neighbouring V2 header actions; the legacy
// header keeps its titlebar button.
export function ComputerUseMenu(props: { variant?: "v2" }) {
  const language = useLanguage()
  const serverSync = useServerSync()
  const [candidate, setCandidate] = createSignal("")
  const enabled = createMemo(() => serverSync().data.config.computer_use?.enabled === true)
  const allowedApps = createMemo(() => serverSync().data.config.computer_use?.allowedApps ?? [])

  // Mirror the allowlist into the desktop store only once the server accepted it,
  // so the two never disagree about which apps are allowed.
  const save = (next: { enabled: boolean; allowedApps: string[] }) =>
    serverSync()
      .updateConfig({ computer_use: next })
      .then(() => window.api?.storeSet?.(COMPUTER_USE_STORE, COMPUTER_USE_KEY, JSON.stringify(next.allowedApps)))
      .catch((err: unknown) => {
        showToast({
          title: language.t("computerUse.saveFailed"),
          description: err instanceof Error ? err.message : String(err),
        })
      })
  const addApp = () => {
    const id = candidate().trim()
    if (!id) return
    setCandidate("")
    if (allowedApps().includes(id)) return
    void save({ enabled: enabled(), allowedApps: [...allowedApps(), id] })
  }

  const icon = () => (
    <Icon
      size="small"
      name="window-cursor"
      classList={{ "text-icon-strong": enabled(), "text-icon-weak": !enabled() }}
    />
  )
  const popover = {
    class: "w-[300px] max-w-[calc(100vw-40px)]",
    gutter: 4,
    placement: "bottom-end" as const,
  }
  const body = () => (
    <div class="flex flex-col gap-3">
      <div class="flex items-center justify-between gap-3">
        <span class="text-12-regular text-text-weak">{language.t("computerUse.disabledHint")}</span>
        <Switch
          checked={enabled()}
          onChange={(checked) => void save({ enabled: checked, allowedApps: allowedApps() })}
          aria-label={language.t(enabled() ? "computerUse.disable" : "computerUse.enable")}
        />
      </div>
      <div class="flex flex-col gap-1">
        <span class="text-12-medium text-text-strong">{language.t("computerUse.allowlist.label")}</span>
        <Show
          when={allowedApps().length > 0}
          fallback={<span class="text-12-regular text-text-weak">{language.t("computerUse.allowlist.empty")}</span>}
        >
          <For each={allowedApps()}>
            {(appID) => (
              <div class="flex items-center justify-between gap-2">
                <span class="text-12-regular text-text-base truncate">{appID}</span>
                <Button
                  variant="ghost"
                  size="small"
                  onClick={() =>
                    void save({ enabled: enabled(), allowedApps: allowedApps().filter((app) => app !== appID) })
                  }
                >
                  {language.t("computerUse.allowlist.remove")}
                </Button>
              </div>
            )}
          </For>
        </Show>
      </div>
      <div class="flex items-center gap-2">
        <TextField
          class="flex-1"
          value={candidate()}
          onChange={setCandidate}
          onKeyDown={(event: KeyboardEvent) => {
            if (event.key === "Enter") addApp()
          }}
          label={language.t("computerUse.allowlist.label")}
          hideLabel
        />
        <Button variant="secondary" size="small" onClick={addApp}>
          {language.t("computerUse.allowlist.add")}
        </Button>
      </div>
    </div>
  )

  return (
    <Show
      when={props.variant === "v2"}
      fallback={
        <Tooltip placement="bottom" value={language.t("computerUse.title")}>
          <Popover
            triggerAs={Button}
            triggerProps={{
              variant: "ghost",
              class: "titlebar-icon w-8 h-6 p-0 box-border",
              "aria-label": language.t("computerUse.title"),
              "data-action": "computer-use-menu",
            }}
            trigger={icon()}
            title={language.t("computerUse.title")}
            {...popover}
          >
            {body()}
          </Popover>
        </Tooltip>
      }
    >
      <TooltipV2 class="shrink-0" placement="bottom" value={language.t("computerUse.title")}>
        <Popover
          triggerAs={IconButtonV2}
          triggerProps={{
            variant: "ghost-muted",
            size: "large",
            class: "!w-9 shrink-0",
            "aria-label": language.t("computerUse.title"),
            "data-action": "computer-use-menu",
          }}
          trigger={icon()}
          title={language.t("computerUse.title")}
          {...popover}
        >
          {body()}
        </Popover>
      </TooltipV2>
    </Show>
  )
}
