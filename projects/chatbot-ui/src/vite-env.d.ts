/// <reference types="vite/client" />

interface ImportMetaEnv {
  VITE_PROD: boolean
  VITE_COMMIT_HASH: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
