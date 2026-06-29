/// <reference types="vite/client" />

declare const __APP_VERSION__: string;

// Explicit ImportMeta augmentation for environments where vite/client
// cannot be resolved by the TypeScript compiler (e.g. worktrees without
// their own node_modules).  This supplements the reference above.
interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly MODE: string;
  readonly BASE_URL: string;
  readonly PROD: boolean;
  readonly DEV: boolean;
  readonly SSR: boolean;
  [key: string]: string | boolean | undefined;
}
