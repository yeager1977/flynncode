interface ImportMetaEnv {
  readonly OPENCODE_CHANNEL: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module "virtual:opencode-server" {
  export namespace Server {
    export const listen: typeof import("../../../flynncode/dist/types/src/node").Server.listen
    export type Listener = import("../../../flynncode/dist/types/src/node").Server.Listener
  }
  export namespace Config {
    export const get: typeof import("../../../flynncode/dist/types/src/node").Config.get
    export type Info = import("../../../flynncode/dist/types/src/node").Config.Info
  }
  export namespace InstanceRuntime {
    export const disposeAllInstances: typeof import("../../../flynncode/dist/types/src/node").InstanceRuntime.disposeAllInstances
  }
  export const bootstrap: typeof import("../../../flynncode/dist/types/src/node").bootstrap
}
