import { useEffect, useState } from 'react'
import { X, TrendingUp, TrendingDown } from 'lucide-react'
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid,
} from 'recharts'
import {
  type Anio, type MayoristaRecord, type ConsumidorRecord,
  RESOURCE_IDS, API_BASE,
  normalize, baseProductName, parsePrice, formatCLP,
  pricePerKilo, pricePerUnit, getCatalog, matchProducts,
} from '../lib/odepa'

interface Props {
  product: string          // base product name
  anio: Anio
  region?: string          // ID region as string (optional scope)
  subsector?: string       // mayorista subsector (optional scope)
  regionLabel?: string     // human label for the active region scope
  onClose: () => void
}

// kg = $/kilo, u = $/unidad (per piece), raw = price as-is (no normalization).
type Basis = 'kg' | 'u' | 'raw'
interface TrendPoint { fecha: string; value: number }
interface Trend { data: TrendPoint[]; basis: Basis; label: string }

const sfx = (b: Basis): string => (b === 'kg' ? '/kg' : b === 'u' ? '/u' : '')
const noun = (b: Basis): string => (b === 'kg' ? 'kg' : 'unidad')

// Comparable value of a row under a basis, or null if not derivable.
function rowValue(price: string, unit: string, basis: Basis): number | null {
  if (basis === 'kg') return pricePerKilo(price, unit)
  if (basis === 'u') return pricePerUnit(price, unit)
  const p = parsePrice(price); return p > 0 ? p : null
}

// Pick the basis that covers ≥50% of rows: prefer $/kg, then $/unidad, else raw.
function chooseBasis(prices: string[], units: string[]): Basis {
  const n = prices.length
  if (!n) return 'raw'
  const kg = prices.filter((p, i) => pricePerKilo(p, units[i]) != null).length
  if (kg / n >= 0.5) return 'kg'
  const u = prices.filter((p, i) => pricePerUnit(p, units[i]) != null).length
  if (u / n >= 0.5) return 'u'
  return 'raw'
}

function searchUrl(
  resourceId: string,
  opts: { fields?: string; filters?: Record<string, unknown>; sort?: string; limit?: number },
): string {
  const p = new URLSearchParams({ resource_id: resourceId, limit: String(opts.limit ?? 100) })
  if (opts.fields) p.set('fields', opts.fields)
  if (opts.filters && Object.keys(opts.filters).length) p.set('filters', JSON.stringify(opts.filters))
  if (opts.sort) p.set('sort', opts.sort)
  return `${API_BASE}?${p}`
}

function avg(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0
}

function dominantUnit(units: string[]): string {
  const counts = new Map<string, number>()
  for (const u of units) counts.set(u, (counts.get(u) ?? 0) + 1)
  let best = ''; let bestN = -1
  for (const [u, n] of counts) if (n > bestN) { best = u; bestN = n }
  return best
}

function fmtDate(d: string): string {
  const [, m, day] = d.split('-')
  return day && m ? `${day}-${m}` : d
}

export default function ProductDetailModal({ product, anio, region, subsector, regionLabel, onClose }: Props) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [trend, setTrend] = useState<Trend | null>(null)
  const [mayVal, setMayVal] = useState<number | null>(null)
  const [mayDate, setMayDate] = useState<string | null>(null)
  const [consVal, setConsVal] = useState<number | null>(null)
  const [consDate, setConsDate] = useState<string | null>(null)
  const [consBasis, setConsBasis] = useState<Basis | null>(null)
  const [consChecked, setConsChecked] = useState(false)

  useEffect(() => {
    let cancelled = false
    const target = normalize(product)

    async function load() {
      setLoading(true); setError(null)
      setTrend(null); setMayVal(null); setMayDate(null)
      setConsVal(null); setConsDate(null); setConsBasis(null); setConsChecked(false)
      try {
        // ── Mayorista trend ──
        const mayRid = RESOURCE_IDS.mayorista[anio]
        const mayCat = await getCatalog(mayRid)
        let mayNames = mayCat.filter(p => normalize(baseProductName(p)) === target)
        if (mayNames.length === 0) mayNames = matchProducts(mayCat, product) // fallback to substring

        const filters: Record<string, unknown> = { Producto: mayNames }
        if (region) filters['ID region'] = Number(region)
        if (subsector) filters['Subsector'] = subsector

        const url = searchUrl(mayRid, {
          fields: 'Fecha,Precio promedio,Unidad de comercializacion',
          filters, sort: 'Fecha asc', limit: 32000,
        })
        const res = await fetch(url)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const rows: MayoristaRecord[] = (await res.json()).result.records

        const basis = chooseBasis(
          rows.map(r => r['Precio promedio']),
          rows.map(r => r['Unidad de comercializacion']),
        )

        const byDate = new Map<string, number[]>()
        for (const r of rows) {
          const v = rowValue(r['Precio promedio'], r['Unidad de comercializacion'], basis)
          if (v == null || v <= 0) continue
          const arr = byDate.get(r.Fecha) ?? []
          arr.push(v); byDate.set(r.Fecha, arr)
        }
        const data: TrendPoint[] = [...byDate.entries()].map(([fecha, arr]) => ({
          fecha, value: Math.round(avg(arr)),
        }))
        const label = basis === 'kg' ? '$/kg'
          : basis === 'u' ? '$/unidad'
          : (dominantUnit(rows.map(r => r['Unidad de comercializacion'])) || '$')

        if (cancelled) return
        setTrend({ data, basis, label })
        if (basis !== 'raw' && data.length) {
          setMayVal(data[data.length - 1].value); setMayDate(data[data.length - 1].fecha)
        }

        // ── Consumidor (margin) ──
        const consRid = RESOURCE_IDS.consumidor[anio]
        const consCat = await getCatalog(consRid)
        const consNames = consCat.filter(p => normalize(baseProductName(p)) === target)
        if (consNames.length) {
          const cf: Record<string, unknown> = { Producto: consNames }
          if (region) cf['ID region'] = Number(region)
          const curl = searchUrl(consRid, {
            fields: 'Fecha inicio,Precio promedio,Unidad',
            filters: cf, sort: 'Fecha inicio desc', limit: 500,
          })
          const cres = await fetch(curl)
          if (cres.ok) {
            const crows: ConsumidorRecord[] = (await cres.json()).result.records
            if (crows.length) {
              const latest = crows[0]['Fecha inicio']
              const week = crows.filter(r => r['Fecha inicio'] === latest)
              const cbasis = chooseBasis(week.map(r => r['Precio promedio']), week.map(r => r.Unidad))
              const vals = week
                .map(r => rowValue(r['Precio promedio'], r.Unidad, cbasis))
                .filter((v): v is number => v != null && v > 0)
              if (vals.length && !cancelled) {
                setConsVal(Math.round(avg(vals))); setConsDate(latest); setConsBasis(cbasis)
              }
            }
          }
        }
        if (!cancelled) setConsChecked(true)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Error de conexión')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    return () => { cancelled = true }
  }, [product, anio, region, subsector])

  const mayBasis = trend?.basis ?? null
  // Margin only when both sides share the same comparable basis ($/kg or $/u).
  const comparable = mayVal != null && consVal != null && mayBasis != null
    && mayBasis !== 'raw' && mayBasis === consBasis
  const margin = comparable ? (consVal as number) - (mayVal as number) : null
  const marginPct = margin != null && mayVal ? (margin / mayVal) * 100 : null
  const scope = regionLabel ? `Región: ${regionLabel}` : 'Todas las regiones'

  return (
    <dialog className="modal modal-open">
      <div className="modal-box max-w-3xl">
        <div className="flex items-start justify-between mb-1">
          <div>
            <h3 className="font-bold text-lg text-green-800 capitalize">{product.toLowerCase()}</h3>
            <p className="text-xs text-gray-400">{scope} · Año {anio}</p>
          </div>
          <button className="btn btn-sm btn-circle btn-ghost" onClick={onClose} aria-label="Cerrar">
            <X size={18} />
          </button>
        </div>

        {loading && (
          <div className="flex justify-center py-16">
            <span className="loading loading-spinner loading-lg text-green-700" />
          </div>
        )}

        {!loading && error && (
          <div role="alert" className="alert alert-error my-4">
            <span>Error al cargar: {error}</span>
          </div>
        )}

        {!loading && !error && (
          <>
            {/* ── Mayorista vs Consumidor ── */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 my-4">
              <div className="bg-green-50 rounded-xl p-3 border border-green-100">
                <p className="text-xs text-gray-500 uppercase tracking-wide">Mayorista (compras)</p>
                <p className="text-xl font-bold text-green-700 font-mono">
                  {mayVal != null && mayBasis ? `${formatCLP(mayVal)}${sfx(mayBasis)}` : '—'}
                </p>
                <p className="text-xs text-gray-400">{mayDate ?? 'sin precio comparable'}</p>
              </div>
              <div className="bg-amber-50 rounded-xl p-3 border border-amber-100">
                <p className="text-xs text-gray-500 uppercase tracking-wide">Consumidor (público)</p>
                <p className="text-xl font-bold text-amber-700 font-mono">
                  {consVal != null && consBasis ? `${formatCLP(consVal)}${sfx(consBasis)}` : '—'}
                </p>
                <p className="text-xs text-gray-400">
                  {consVal != null ? `semana ${consDate}` : consChecked ? 'sin datos de consumidor' : ''}
                </p>
              </div>
              <div className="bg-gray-50 rounded-xl p-3 border border-gray-200">
                <p className="text-xs text-gray-500 uppercase tracking-wide">Margen referencial</p>
                {margin != null && mayBasis ? (
                  <>
                    <p className={`text-xl font-bold font-mono flex items-center gap-1 ${margin >= 0 ? 'text-green-700' : 'text-red-600'}`}>
                      {margin >= 0 ? <TrendingUp size={18} /> : <TrendingDown size={18} />}
                      {formatCLP(Math.abs(margin))}{sfx(mayBasis)}
                    </p>
                    <p className="text-xs text-gray-400">
                      {marginPct != null ? `${marginPct >= 0 ? '+' : ''}${marginPct.toFixed(0)}% · por ${noun(mayBasis)}` : ''}
                    </p>
                  </>
                ) : (
                  <p className="text-sm text-gray-400 mt-1">
                    {consVal != null && mayBasis !== consBasis ? 'Bases distintas (kg vs unidad)' : 'No comparable'}
                  </p>
                )}
              </div>
            </div>

            {/* ── Trend chart ── */}
            <div className="mt-2">
              <div className="flex items-baseline justify-between mb-1">
                <h4 className="font-semibold text-sm text-gray-700">Tendencia mayorista ({trend?.label ?? '—'})</h4>
                {trend && trend.basis === 'u' && (
                  <span className="text-xs text-gray-500">Producto por unidad ($/u)</span>
                )}
                {trend && trend.basis === 'raw' && (
                  <span className="text-xs text-amber-600">Precio sin normalizar (unidades mixtas)</span>
                )}
              </div>
              {trend && trend.data.length > 1 ? (
                <div className="h-64 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={trend.data} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
                      <XAxis dataKey="fecha" tickFormatter={fmtDate} minTickGap={40} fontSize={11} stroke="#999" />
                      <YAxis
                        width={70}
                        fontSize={11}
                        stroke="#999"
                        tickFormatter={(v: number) => formatCLP(v)}
                        domain={['auto', 'auto']}
                      />
                      <Tooltip
                        formatter={(v) => [formatCLP(Number(v)), trend.label] as [string, string]}
                        labelFormatter={(l) => `Fecha: ${l}`}
                      />
                      <Line type="monotone" dataKey="value" stroke="#15803d" strokeWidth={2} dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <p className="text-sm text-gray-400 py-8 text-center">Sin datos suficientes para graficar la tendencia.</p>
              )}
            </div>

            <p className="text-xs text-gray-400 mt-3">
              Precio comparable estimado desde la unidad de comercialización ($/kg si tiene peso, si no $/unidad).
              El margen es referencial: el precio al consumidor incluye distribución, mermas y otros costos.
            </p>
          </>
        )}

        <div className="modal-action mt-4">
          <button className="btn btn-sm" onClick={onClose}>Cerrar</button>
        </div>
      </div>
      <form method="dialog" className="modal-backdrop" onClick={onClose}>
        <button>close</button>
      </form>
    </dialog>
  )
}
