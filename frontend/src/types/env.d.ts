// Type declarations for environment variables injected by react-native-dotenv.
// Keep this list in sync with `.env.example`.

declare module '@env' {
  export const API_BASE_URL: string;
  export const OCR_PROVIDER: string;
}

// Also type the `process.env.<NAME>` access form (react-native-dotenv inlines
// these at build time). Vars are optional at the type level because the babel
// plugin replaces missing ones with `undefined`.
declare global {
  namespace NodeJS {
    interface ProcessEnv {
      API_BASE_URL?: string;
      OCR_PROVIDER?: string;
    }
  }
}

export {};
