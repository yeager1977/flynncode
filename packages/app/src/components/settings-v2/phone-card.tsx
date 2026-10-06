import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { type Component, For, Show, createEffect, createResource, createSignal } from "solid-js"
import { useLanguage } from "@/context/language"
import { SettingsListV2 } from "./parts/list"
import { canEncodeQr, drawQrToCanvas } from "./phone-qr"

type MobileGatewayStatus = {
  running: boolean
  port: number
  lanUrls: string[]
  launcherUrls: string[]
}

const STOPPED_STATUS: MobileGatewayStatus = { running: false, port: 4097, lanUrls: [], launcherUrls: [] }

export const PhoneCard: Component = () => {
  const language = useLanguage()
  const [status] = createResource(async () => {
    const api = (window as unknown as { api?: { getMobileGatewayStatus?: () => Promise<MobileGatewayStatus> } })
      .api
    if (!api?.getMobileGatewayStatus) return STOPPED_STATUS
    return api.getMobileGatewayStatus()
  })
  const [copied, setCopied] = createSignal<string>()
  let qrCanvas: HTMLCanvasElement | undefined

  const launcherUrls = () => status()?.launcherUrls ?? []
  const running = () => status()?.running === true && launcherUrls().length > 0
  const qrUrl = () => {
    const first = launcherUrls()[0]
    return first && canEncodeQr(first) ? first : undefined
  }

  const copyUrl = (url: string) => {
    const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard
    if (!clipboard?.writeText) return
    void clipboard.writeText(url).then(() => {
      setCopied(url)
      setTimeout(() => setCopied((current) => (current === url ? undefined : current)), 2000)
    })
  }

  createEffect(() => {
    const url = qrUrl()
    if (qrCanvas && url) drawQrToCanvas(qrCanvas, url)
  })

  return (
    <Show when={!status.loading}>
      <SettingsListV2>
        <div class="settings-v2-servers-row">
          <div class="settings-v2-servers-lead">
            <div
              aria-hidden="true"
              classList={{
                "size-1.5 rounded-full shrink-0 my-[3.5px]": true,
                "bg-icon-success-base": running(),
                "bg-border-weak-base": !running(),
              }}
            />
            <div class="settings-v2-servers-copy">
              <span class="settings-v2-servers-name">{language.t("server.phone.title")}</span>
              <span class="settings-v2-servers-meta">
                <Show when={running()} fallback={language.t("server.phone.stopped")}>
                  {language.t("server.phone.hint")}
                </Show>
              </span>
            </div>
          </div>
        </div>
        <Show when={running()}>
          <For each={launcherUrls()}>
            {(url) => (
              <div class="settings-v2-servers-row">
                <div class="settings-v2-servers-lead">
                  <div class="settings-v2-servers-copy">
                    <span class="settings-v2-servers-name">{url}</span>
                  </div>
                </div>
                <div class="settings-v2-servers-actions">
                  <ButtonV2 size="small" variant="ghost-muted" onClick={() => copyUrl(url)}>
                    <Show when={copied() === url} fallback={language.t("server.phone.copy")}>
                      {language.t("session.share.copy.copied")}
                    </Show>
                  </ButtonV2>
                </div>
              </div>
            )}
          </For>
          <Show when={qrUrl()}>
            <div class="settings-v2-servers-row">
              <canvas
                ref={(element) => {
                  qrCanvas = element
                }}
                aria-label={language.t("server.phone.title")}
                style={{ width: "128px", height: "128px", "image-rendering": "pixelated" }}
              />
            </div>
          </Show>
        </Show>
      </SettingsListV2>
    </Show>
  )
}
