import { Button } from "@flynncode/ui/button"
import { Card, CardActions, CardDescription, CardTitle } from "@flynncode/ui/card"
import { Show, createMemo } from "solid-js"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useProviders } from "@/hooks/use-providers"
import { usageLimitResetTime } from "@/utils/usage-limit"
import type { TimelineRow } from "./timeline-row"

export function UsageLimitCard(props: { limit: TimelineRow.UsageLimit; message: string; child?: boolean }) {
  const language = useLanguage()
  const command = useCommand()
  const sdk = useSDK()
  const providers = useProviders(() => sdk().directory)

  const model = createMemo(
    () =>
      providers.all().get(props.limit.providerID)?.models[props.limit.modelID]?.name ??
      `${props.limit.providerID}/${props.limit.modelID}`,
  )
  const resets = createMemo(() => {
    const resetAt = props.limit.resetAt
    if (resetAt === undefined) return
    return language.t("session.usageLimit.resets", { time: usageLimitResetTime(resetAt, language.intl()) })
  })

  return (
    <Card variant="error" class="error-card" data-component="usage-limit-card">
      <CardTitle variant="error">{language.t("session.usageLimit.title", { model: model() })}</CardTitle>
      <Show when={resets()}>{(text) => <CardDescription>{text()}</CardDescription>}</Show>
      <Show when={props.message}>
        <CardDescription>{props.message}</CardDescription>
      </Show>
      {/* The composer model does not affect a subagent, so only the parent
          offers a switch. */}
      <Show when={!props.child}>
        <CardActions>
          <Button
            type="button"
            size="small"
            variant="secondary"
            data-action="usage-limit-switch-model"
            onClick={() => command.trigger("model.choose")}
          >
            {language.t("session.usageLimit.switchModel")}
          </Button>
        </CardActions>
      </Show>
    </Card>
  )
}
