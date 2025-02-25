/// <reference types="vite/client" />

interface ImportMetaEnv {
  VITE_PROD: boolean
  // 他の環境変数も追加可能
  VITE_APP_VERSION: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
