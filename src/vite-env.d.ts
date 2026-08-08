/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the CORS proxy worker, set at build time. */
  readonly VITE_PROXY_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
