import { createSignal, For, Show } from "solid-js"
import { getFilename } from "@opencode-ai/core/util/path"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { DialogBody, DialogFooter, DialogHeader, DialogTitleGroup, DialogV2 } from "@opencode-ai/ui/v2/dialog-v2"
import { RadioGroupV2, RadioItemV2 } from "@opencode-ai/ui/v2/radio-v2"
import { useLanguage } from "@/context/language"

// Confirms a worktree handoff before anything moves or is archived, naming the
// destination and letting the user pick one when several worktrees exist.
export function SessionHandoffDialog(props: {
  targets: string[]
  primary: string
  create: boolean
  hasSession: boolean
  onConfirm: (target: string | undefined) => void
}) {
  const dialog = useDialog()
  const language = useLanguage()
  const [target, setTarget] = createSignal(props.targets[0])

  const label = (directory: string) =>
    directory === props.primary ? language.t("session.new.worktree.main") : getFilename(directory)

  const description = () => {
    if (props.create) return language.t("session.handoff.confirm.create")
    const selected = target()
    if (!selected) return ""
    const name = label(selected)
    if (!props.hasSession) return language.t("session.handoff.confirm.open", { target: name })
    // Leaving a worktree rebinds its sessions, so this session itself moves;
    // leaving the main checkout starts a new session and archives this one.
    if (selected === props.primary) return language.t("session.handoff.confirm.move", { target: name })
    return language.t("session.handoff.confirm.restart", { target: name })
  }

  return (
    <DialogV2 fit>
      <DialogHeader hideClose>
        <DialogTitleGroup title={language.t("session.handoff.confirm.title")} description={description()} />
      </DialogHeader>
      <Show when={props.targets.length > 1}>
        <DialogBody>
          <RadioGroupV2 label={language.t("session.handoff.confirm.pick")} value={target()} onChange={setTarget}>
            <For each={props.targets}>
              {(directory) => <RadioItemV2 value={directory} label={label(directory)} description={directory} />}
            </For>
          </RadioGroupV2>
        </DialogBody>
      </Show>
      <DialogFooter>
        <ButtonV2 variant="ghost" onClick={() => dialog.close()}>
          {language.t("common.cancel")}
        </ButtonV2>
        <ButtonV2
          variant="contrast"
          data-action="session-handoff-confirm"
          disabled={!props.create && !target()}
          onClick={() => {
            dialog.close()
            props.onConfirm(target())
          }}
        >
          {props.create ? language.t("session.new.worktree.create") : language.t("session.handoff.confirm.action")}
        </ButtonV2>
      </DialogFooter>
    </DialogV2>
  )
}
