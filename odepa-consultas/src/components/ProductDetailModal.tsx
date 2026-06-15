import { useEffect, useState } from 'react'
import { X, TrendingUp, TrendingDown } from 'lucide-react'
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid,
} from 'recharts'
import {
  type Anio, type MayoristaRecord, type ConsumidorRecord,
  RESOURCE_IDS, API_BASE,
  normalize, baseProductName, parsePrice, formatCLP, pricePerKilo, getCatalog, matchProducts,
} from '../lib/odepa'

interface Props {
  product: string          // base product name
  anio: Anio
  region?: string          // ID region as string (optional scope)
  subsector?: string       // mayorista subsector (optional scope)
  regionLabel?: string     // human label for the active region scope
  onClose: () => void
}

interface TrendPoint { fecha: string; value: number }
interface Trend { data: TrendPoint[]; kgMode: boolean; unitLabel: string }

// Build a datastore_search URL through the proxy.
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
  // "2026-01-02" -> "02-01"
  const [, m, day] = d.split('-')
  return day && m ? `${day}-${m}` : d
}

export default function ProductDetailModal({ product, anio, region, subsector, regionLabel, onClose }: Props) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [trend, setTrend] = useState<Trend | null>(null)
  const [mayKg, setMayKg] = useState<number | null>(null)
  const [mayDate, setMayDate] = useState<string | null>(null)
  const [consKg, setConsKg] = useState<number | null>(null)
  const [consDate, setConsDate] = useState<string | null>(null)
  const [consChecked, setConsChecked] = useState(false)

  useEffect(() => {
    let cancelled = false
    const target = normalize(product)

    async function load() {
      setLoading(true); setError(null)
      setTrend(null); setMayKg(null); setMayDate(null); setConsKg(null); setConsDate(null); setConsChecked(false)
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

        const convCount = rows.filter(
          r => pricePerKilo(r['Precio promedio'], r['Unidad de comercializacion']) != null,
        ).length
        const kgMode = rows.length > 0 && convCount / rows.length >= 0.5

        const byDate = new Map<string, number[]>()
        for (const r of rows) {
          const v = kgMode
            ? pricePerKilo(r['Precio promedio'], r['Unidad de comercializacion'])
            : parsePrice(r['Precio promedio'])
          if (v == null || v <= 0) continue
          const arr = byDate.get(r.Fecha) ?? []
          arr.push(v); byDate.set(r.Fecha, arr)
        }
        const data: TrendPoint[] = [...byDate.entries()].map(([fecha, arr]) => ({
          fecha, value: Math.round(avg(arr)),
        }))
        const unitLabel = kgMode ? '$/kg' : (dominantUnit(rows.map(r => r['Unidad de comercializacion'])) || '$')

        if (cancelled) return
        setTrend({ data, kgMode, unitLabel })
        if (kgMode && data.length) { setMayKg(data[data.length - 1].value); setMayDate(data[data.length - 1].fecha) }

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
              const kgs = crows
                .filter(r => r['Fecha inicio'] === latest)
                .map(r => pricePerKilo(r['Precio promedio'], r.Unidad))
                .filter((v): v is number => v != null && v > 0)
              if (kgs.length && !cancelled) { setConsKg(Math.round(avg(kgs))); setConsDate(latest) }
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

  const margin = mayKg != null && consKg != null ? consKg - mayKg : null
  const marginPct = margin != null && mayKg ? (margin / mayKg) * 100 : null
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
                  {mayKg != null ? `${formatCLP(mayKg)}/kg` : '—'}
                </p>
                <p className="text-xs text-gray-400">{mayDate ?? 'sin $/kg comparable'}</p>
              </div>
              <div className="bg-amber-50 rounded-xl p-3 border border-amber-100">
                <p className="text-xs text-gray-500 uppercase tracking-wide">Consumidor (público)</p>
                <p className="text-xl font-bold text-amber-700 font-mono">
                  {consKg != null ? `${formatCLP(consKg)}/kg` : '—'}
                </p>
                <p className="text-xs text-gray-400">
                  {consKg != null ? `semana ${consDate}` : consChecked ? 'sin datos de consumidor' : ''}
                </p>
              </div>
              <div className="bg-gray-50 rounded-xl p-3 border border-gray-200">
                <p className="text-xs text-gray-500 uppercase tracking-wide">Margen referencial</p>
                {margin != null ? (
                  <>
                    <p className={`text-xl font-bold font-mono flex items-center gap-1 ${margin >= 0 ? 'text-green-700' : 'text-red-600'}`}>
                      {margin >= 0 ? <TrendingUp size={18} /> : <TrendingDown size={18} />}
                      {formatCLP(Math.abs(margin))}/kg
                    </p>
                    <p className="text-xs text-gray-400">
                      {marginPct != null ? `${marginPct >= 0 ? '+' : ''}${marginPct.toFixed(0)}% sobre mayorista` : ''}
                    </p>
                  </>
                ) : (
                  <p className="text-sm text-gray-400 mt-1">No comparable en $/kg</p>
                )}
              </div>
            </div>

            {/* ── Trend chart ── */}
            <div className="mt-2">
              <div className="flex items-baseline justify-between mb-1">
                <h4 className="font-semibold text-sm text-gray-700">Tendencia mayorista ({trend?.unitLabel ?? '—'})</h4>
                {trend && !trend.kgMode && (
                  <span className="text-xs text-amber-600">Producto por unidad: precio sin convertir a $/kg</span>
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
                        formatter={(v) => [formatCLP(Number(v)), trend.unitLabel] as [string, string]}
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
              $/kg estimado a partir de la unidad de comercialización. El margen es referencial: el precio
              al consumidor incluye costos de distribución, mermas y otros que no son tu margen real.
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
