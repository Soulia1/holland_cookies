/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Where the API lives.
   *
   * Empty in production — the Express server serves the bundle and the API from
   * one origin, so a relative path is correct and there is no CORS to arrange.
   * Set only when the front end runs on the Vite dev server against a separate
   * backend process.
   */
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
