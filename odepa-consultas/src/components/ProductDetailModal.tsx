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
  variedad?: string
  calidad?: string
  regionLabel?: string     // human label for the active region scope
  onClose: () => void
}

// kg = $/kilo, u = $/unidad (per piece), raw = price as-is (no normalization).
type Basis = 'kg' | 'u' | 'raw'
interface TrendPoint { fecha: string; value: number }
interface Trend { data: TrendPoint[]; basis: Basis; label: string }
interface ConsPuntoData { val: number; date: string; basis: Basis }

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

export default function ProductDetailModal({ product, anio, region, subsector, variedad, calidad, regionLabel, onClose }: Props) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [trend, setTrend] = useState<Trend | null>(null)
  const [mayVal, setMayVal] = useState<number | null>(null)
  const [mayDate, setMayDate] = useState<string | null>(null)
  const [consByPunto, setConsByPunto] = useState<Record<string, ConsPuntoData>>({})
  const [consChecked, setConsChecked] = useState(false)
  const [fallbackNotice, setFallbackNotice] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const target = normalize(product)

    async function load() {
      setLoading(true); setError(null)
      setTrend(null); setMayVal(null); setMayDate(null)
      setConsByPunto({}); setConsChecked(false); setFallbackNotice(null)
      try {
        // ── Mayorista trend ──
        const mayRid = RESOURCE_IDS.mayorista[anio]
        const mayCat = await getCatalog(mayRid)
        let mayNames = mayCat.filter(p => normalize(baseProductName(p)) === target)
        if (mayNames.length === 0) mayNames = matchProducts(mayCat, product)

        const fetchMayRows = async (extra: Record<string, unknown>) => {
          const mf: Record<string, unknown> = { Producto: mayNames, ...extra }
          if (region) mf['ID region'] = Number(region)
          if (subsector) mf['Subsector'] = subsector
          const url = searchUrl(mayRid, {
            fields: 'Fecha,Precio promedio,Unidad de comercializacion',
            filters: mf, sort: 'Fecha asc', limit: 32000,
          })
          const res = await fetch(url)
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          return (await res.json()).result.records as MayoristaRecord[]
        }

        const buildTrend = (rows: MayoristaRecord[]) => {
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
          return { data, basis, label }
        }

        const scopeExtra: Record<string, unknown> = {}
        if (variedad) scopeExtra['Variedad / Tipo'] = variedad
        if (calidad) scopeExtra['Calidad'] = calidad
        const hasScope = Object.keys(scopeExtra).length > 0

        let rows = await fetchMayRows(scopeExtra)
        let trendResult = buildTrend(rows)

        if (hasScope && trendResult.data.length < 2) {
          rows = await fetchMayRows({})
          trendResult = buildTrend(rows)
          const scopeStr = [variedad, calidad].filter(Boolean).join(' · ')
          if (!cancelled) setFallbackNotice(`Sin datos suficientes para "${scopeStr}" — mostrando tendencia del producto completo.`)
        }

        if (cancelled) return
        setTrend(trendResult)
        if (trendResult.basis !== 'raw' && trendResult.data.length) {
          setMayVal(trendResult.data[trendResult.data.length - 1].value)
          setMayDate(trendResult.data[trendResult.data.length - 1].fecha)
        }

        // ── Consumidor (margin) ──
        const consRid = RESOURCE_IDS.consumidor[anio]
        const consCat = await getCatalog(consRid)
        const allConsNames = consCat.filter(p => normalize(baseProductName(p)) === target)
        // Try to narrow to matching variedad/calidad (consumidor uses "Base|Variedad|Calidad" format).
        let consNames = allConsNames
        if ((variedad || calidad) && !fallbackNotice) {
          const narrow = allConsNames.filter(p => {
            const parts = p.split('|')
            const pVar = normalize(parts[1]?.trim() ?? '')
            const pCal = normalize(parts[2]?.trim() ?? '')
            const varOk = !variedad || pVar.includes(normalize(variedad))
            const calOk = !calidad || pCal.includes(normalize(calidad))
            return varOk && calOk
          })
          if (narrow.length) consNames = narrow
          // else: fall back silently to all base names (different naming across datasets)
        }
        if (consNames.length) {
          const cf: Record<string, unknown> = { Producto: consNames }
          if (region) cf['ID region'] = Number(region)
          const curl = searchUrl(consRid, {
            fields: 'Fecha inicio,Precio promedio,Unidad,Tipo de punto monitoreo',
            filters: cf, sort: 'Fecha inicio desc', limit: 500,
          })
          const cres = await fetch(curl)
          if (cres.ok) {
            const crows: ConsumidorRecord[] = (await cres.json()).result.records
            if (crows.length) {
              const latest = crows[0]['Fecha inicio']
              const week = crows.filter(r => r['Fecha inicio'] === latest)
              const byPunto = new Map<string, ConsumidorRecord[]>()
              for (const r of week) {
                const punto = r['Tipo de punto monitoreo'] || 'Otros'
                byPunto.set(punto, [...(byPunto.get(punto) ?? []), r])
              }
              const result: Record<string, ConsPuntoData> = {}
              for (const [punto, rows] of byPunto) {
                const cbasis = chooseBasis(rows.map(r => r['Precio promedio']), rows.map(r => r.Unidad))
                const vals = rows
                  .map(r => rowValue(r['Precio promedio'], r.Unidad, cbasis))
                  .filter((v): v is number => v != null && v > 0)
                if (vals.length) result[punto] = { val: Math.round(avg(vals)), date: latest, basis: cbasis }
              }
              if (!cancelled) setConsByPunto(result)
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
  }, [product, anio, region, subsector, variedad, calidad])

  const mayBasis = trend?.basis ?? null
  const marginFor = (data: ConsPuntoData | undefined) => {
    if (!data || mayVal == null || mayBasis == null || mayBasis === 'raw') return null
    if (mayBasis !== data.basis) return null
    return data.val - mayVal
  }
  const scopeParts = [
    regionLabel ? `Región: ${regionLabel}` : 'Todas las regiones',
    !fallbackNotice && variedad,
    !fallbackNotice && calidad,
  ].filter(Boolean).join(' · ')
  const scope = scopeParts

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
              {(['Feria libre', 'Supermercado'] as const).map(punto => {
                const data = consByPunto[punto]
                const m = marginFor(data)
                const mPct = m != null && mayVal ? (m / mayVal) * 100 : null
                return (
                  <div key={punto} className="bg-amber-50 rounded-xl p-3 border border-amber-100">
                    <p className="text-xs text-gray-500 uppercase tracking-wide">Consumidor · {punto}</p>
                    <p className="text-xl font-bold text-amber-700 font-mono">
                      {data ? `${formatCLP(data.val)}${sfx(data.basis)}` : '—'}
                    </p>
                    {data && m != null && mayBasis ? (
                      <p className={`text-xs flex items-center gap-0.5 mt-0.5 ${m >= 0 ? 'text-green-600' : 'text-red-500'}`}>
                        {m >= 0 ? <TrendingUp size={11} /> : <TrendingDown size={11} />}
                        {formatCLP(Math.abs(m))}{sfx(mayBasis)}
                        {mPct != null ? ` (${mPct >= 0 ? '+' : ''}${mPct.toFixed(0)}%)` : ''}
                      </p>
                    ) : (
                      <p className="text-xs text-gray-400 mt-0.5">
                        {consChecked && !data ? 'sin datos' : data && m == null ? 'base distinta' : ''}
                      </p>
                    )}
                  </div>
                )
              })}
            </div>

            {/* Fallback notice */}
            {fallbackNotice && (
              <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-3 text-xs text-amber-700">
                <span className="shrink-0">⚠️</span>
                <span>{fallbackNotice}</span>
              </div>
            )}

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
