/// <reference types="vite/client" />

interface ImportMetaEnv {
  // Base URL del backend Spring Boot (Railway) del que se lee mercado.unidad_conversion.
  // Si no está definida, el frontend usa el fallback de conversión por regex.
  readonly VITE_BACKEND_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
