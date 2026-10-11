import { useLanguage } from "@/context/language"
import { Button } from "@flynncode/ui/button"
import { useDialog } from "@flynncode/ui/context/dialog"
import { Dialog } from "@flynncode/ui/dialog"

export function DialogMetaContributor(props: { onContinue: () => void; onCancel: () => void }) {
  const dialog = useDialog()
  const language = useLanguage()

  const cancel = () => {
    props.onCancel()
    dialog.close()
  }

  const cont = () => {
    props.onContinue()
    dialog.close()
  }

  return (
    <Dialog title={language.t("dialog.metaContributor.title")} description={language.t("dialog.metaContributor.description")} fit>
      <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
        <div class="flex justify-end gap-2">
          <Button variant="ghost" size="large" onClick={cancel}>
            {language.t("common.cancel")}
          </Button>
          <Button variant="primary" size="large" onClick={cont}>
            {language.t("common.continue")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
