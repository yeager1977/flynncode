import { Button } from "@flynncode/ui/button"
import { Spinner } from "@flynncode/ui/spinner"
import { Match, Switch } from "solid-js"
import { useLanguage } from "@/context/language"

// Provider pickers list only the connected providers until the full catalog arrives. Say so while it loads, and
// offer a retry when it fails, instead of looking like those are all the providers there are.
export function ProviderCatalogStatus(props: {
  catalog: { loading: () => boolean; failed: () => boolean; retry: () => void }
  class?: string
}) {
  const language = useLanguage()
  return (
    <Switch>
      <Match when={props.catalog.loading()}>
        <div
          data-component="provider-catalog-status"
          data-state="loading"
          role="status"
          class={`flex items-center gap-2 px-3 py-2 text-14-regular text-text-weak ${props.class ?? ""}`}
        >
          <Spinner class="size-4 shrink-0" />
          <span>{language.t("dialog.provider.catalog.loading")}</span>
        </div>
      </Match>
      <Match when={props.catalog.failed()}>
        <div
          data-component="provider-catalog-status"
          data-state="error"
          role="alert"
          class={`flex items-center gap-2 px-3 py-2 text-14-regular text-text-weak ${props.class ?? ""}`}
        >
          <span class="min-w-0 flex-1">{language.t("dialog.provider.catalog.error")}</span>
          <Button size="small" variant="secondary" onClick={() => props.catalog.retry()}>
            {language.t("dialog.provider.catalog.retry")}
          </Button>
        </div>
      </Match>
    </Switch>
  )
}
