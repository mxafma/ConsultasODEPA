// Shared constants, types and helpers for the ODEPA price app.
// Used by both the main search view (App.tsx) and the product detail modal.

// ── Constants ────────────────────────────────────────────────────────────────

export const RESOURCE_IDS = {
  mayorista: {
    2024: '11b8b84f-f409-4fa8-9764-2c874e703cc3',
    2025: '92353fad-463e-4e85-a3ff-accb0286d0c5',
    2026: '580beca0-e87e-4dd4-9e8a-0bd92773f4a6',
  },
  consumidor: {
    2024: '5f773b96-6c3a-4017-b871-6340d779ea96',
    2025: 'eab239c4-e338-4cde-a9e0-7c4f27826030',
    2026: '9f885df4-afeb-4b75-8bab-9334f79db00f',
  },
} as const

export type TipoPrecio = 'mayorista' | 'consumidor'
export type Anio = 2024 | 2025 | 2026

export const SORT_FIELD: Record<TipoPrecio, string> = {
  mayorista: 'Fecha',
  consumidor: 'Fecha inicio',
}

export const TIPOS_MONITOREO = ['Feria libre', 'Supermercado']
export const GRUPOS_CONSUMIDOR = ['Frutas', 'Hortalizas']

export const REGIONS = [
  { id: 1,  name: 'Tarapacá' },
  { id: 2,  name: 'Antofagasta' },
  { id: 3,  name: 'Atacama' },
  { id: 4,  name: 'Coquimbo' },
  { id: 5,  name: 'Valparaíso' },
  { id: 6,  name: "O'Higgins" },
  { id: 7,  name: 'Maule' },
  { id: 8,  name: 'Biobío' },
  { id: 9,  name: 'La Araucanía' },
  { id: 10, name: 'Los Lagos' },
  { id: 11, name: 'Aysén' },
  { id: 12, name: 'Magallanes' },
  { id: 13, name: 'Metropolitana' },
  { id: 14, name: 'Los Ríos' },
  { id: 15, name: 'Arica y Parinacota' },
  { id: 16, name: 'Ñuble' },
]

export const PAGE_SIZE = 25
export const API_BASE = '/api/search'
// Cap the IN-list passed to the API so a very broad term can't blow up the URL.
export const MAX_PRODUCT_MATCHES = 120

// ── Types ────────────────────────────────────────────────────────────────────

export interface Filters {
  producto: string
  region: string     // ID region as string, e.g. "13"
  subsector: string
  grupo: string
  tipoMonitoreo: string
  mercado: string
}

export interface MayoristaRecord {
  _id: number
  Fecha: string
  'ID region': string
  Region: string
  Mercado: string
  Subsector: string
  Producto: string
  'Variedad / Tipo': string
  Calidad: string
  'Unidad de comercializacion': string
  Origen: string
  Volumen: string
  'Precio minimo': string
  'Precio maximo': string
  'Precio promedio': string
}

export interface ConsumidorRecord {
  _id: number
  Anio: string
  Mes: string
  Semana: string
  'Fecha inicio': string
  'Fecha termino': string
  'ID region': string
  Region: string
  Sector: string
  'Tipo de punto monitoreo': string
  Grupo: string
  Producto: string
  Unidad: string
  'Precio minimo': string
  'Precio maximo': string
  'Precio promedio': string
}

export type PriceRecord = MayoristaRecord | ConsumidorRecord

export interface ApiResponse {
  result: { total: number; records: PriceRecord[] }
}

// ── Text / price helpers ──────────────────────────────────────────────────────

// Strip accents + lowercase so "platano" matches "Plátano" (accent-insensitive).
export function normalize(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()
}

// Base product name (consumidor stores "Base|Variedad|Calidad").
export function baseProductName(p: string): string {
  return p.split('|')[0].trim()
}

function num(s: string): number {
  return parseFloat(s.replace(',', '.'))
}

export function parsePrice(val: string): number {
  if (!val) return 0
  return parseFloat(val.replace(',', '.')) || 0
}

export function formatCLP(n: number): string {
  if (!n) return '—'
  return n.toLocaleString('es-CL', { style: 'currency', currency: 'CLP', maximumFractionDigits: 0 })
}

export function formatPrice(val: string): string { return formatCLP(parsePrice(val)) }

export function regionName(id: string): string {
  return REGIONS.find(r => String(r.id) === id)?.name ?? id
}

export function pageWindow(page: number, total: number): number[] {
  if (total <= 5) return Array.from({ length: total }, (_, i) => i + 1)
  if (page <= 3) return [1, 2, 3, 4, 5]
  if (page >= total - 2) return [total - 4, total - 3, total - 2, total - 1, total]
  return [page - 2, page - 1, page, page + 1, page + 2]
}

// ── $/kg normalization ─────────────────────────────────────────────────────────

// How many kilos one commercialization unit represents, or null if not derivable.
// Examples: "$/kilo" -> 1, "$/caja 18 kilos" -> 18, "$/docena de atados (6 kilos)" -> 6,
// "$/atado 0,5 a 1 kilo" -> 0.75, "$/bolsa 800 grs" -> 0.8,
// "$/bandeja 12 canastillos 125 gramos" -> 1.5 (12 × 125 g). Unit-based ("$/unidad",
// "$/caja 12 unidades", "$/docena de matas") -> null (not convertible to $/kg).
export function unitToKilos(unit: string): number | null {
  if (!unit) return null
  const s = unit.toLowerCase()
  if (s.startsWith('$/kilo')) return 1 // already per kilo; parenthetical packaging is irrelevant

  // Multiplicative pack, e.g. "$/bandeja 12 canastillos 125 gramos" = 12 × 125 g.
  // Must run before the single-weight matches below, which would otherwise read
  // only "125 gramos" and overstate $/kg ~12×.
  const pack = s.match(/([\d.,]+)\s*canastillos?\s*([\d.,]+)\s*(kilo|gramo)/)
  if (pack) {
    const count = num(pack[1]); const each = num(pack[2])
    if (count > 0 && each > 0) return count * (pack[3] === 'gramo' ? each / 1000 : each)
  }

  // Weight range, e.g. "0,5 a 1 kilo" / "300 a 500 gramos" → midpoint.
  const range = s.match(/([\d.,]+)\s*a\s*([\d.,]+)\s*(kilo|gramo)/)
  if (range) {
    const a = num(range[1]); const b = num(range[2])
    if (a > 0 && b > 0) {
      const mid = (a + b) / 2
      return range[3] === 'gramo' ? mid / 1000 : mid
    }
  }

  const kg = s.match(/([\d.,]+)\s*kilo/) // "18 kilos"
  if (kg) { const n = num(kg[1]); if (n > 0) return n }

  const g = s.match(/([\d.,]+)\s*(?:gramo|grs?\b)/) // "800 gramos" / "800 grs"
  if (g) { const n = num(g[1]); if (n > 0) return n / 1000 }

  return null
}

// Price per kilo for a record, or null when the unit can't be reduced to kilos.
export function pricePerKilo(priceStr: string, unit: string): number | null {
  const kilos = unitToKilos(unit)
  if (!kilos || kilos <= 0) return null
  const p = parsePrice(priceStr)
  if (!p) return null
  return p / kilos
}

// ── Catalogue (distinct product names per resource) ─────────────────────────────

const catalogCache: Record<string, string[]> = {}

// Distinct product names for a resource, fetched once and cached for the session.
export async function getCatalog(resourceId: string): Promise<string[]> {
  if (catalogCache[resourceId]) return catalogCache[resourceId]
  const res = await fetch(`${API_BASE}?catalog=Producto&resource_id=${resourceId}`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data: { values?: string[] } = await res.json()
  const values = data.values ?? []
  catalogCache[resourceId] = values
  return values
}

// Catalogue entries whose name contains the term, ignoring accents/case.
export function matchProducts(catalog: string[], term: string, limit = MAX_PRODUCT_MATCHES): string[] {
  const q = normalize(term)
  if (!q) return []
  return catalog.filter(p => normalize(p).includes(q)).slice(0, limit)
}
