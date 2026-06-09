import { useState } from 'react'
import { Package, Search, RefreshCw, ChevronUp, ChevronDown, X } from 'lucide-react'

// ── Constants ────────────────────────────────────────────────────────────────

const RESOURCE_IDS = {
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

const SORT_FIELD: Record<TipoPrecio, string> = {
  mayorista: 'Fecha',
  consumidor: 'Fecha inicio',
}

const TIPOS_MONITOREO = ['Feria libre', 'Supermercado']
const GRUPOS_CONSUMIDOR = ['Frutas', 'Hortalizas']

const REGIONS = [
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

const PAGE_SIZE = 25
const API_BASE = '/api/search'

// ── Types ────────────────────────────────────────────────────────────────────

type TipoPrecio = 'mayorista' | 'consumidor'
type Anio = 2024 | 2025 | 2026

interface Filters {
  producto: string
  region: string     // ID region as string, e.g. "13"
  subsector: string
  grupo: string
  tipoMonitoreo: string
  mercado: string
}

interface MayoristaRecord {
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

interface ConsumidorRecord {
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

type PriceRecord = MayoristaRecord | ConsumidorRecord

interface ApiResponse {
  result: { total: number; records: PriceRecord[] }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function parsePrice(val: string): number {
  if (!val) return 0
  return parseFloat(val.replace(',', '.')) || 0
}

function formatCLP(n: number): string {
  if (n === 0) return '—'
  return n.toLocaleString('es-CL', { style: 'currency', currency: 'CLP', maximumFractionDigits: 0 })
}

function formatPrice(val: string): string { return formatCLP(parsePrice(val)) }

function pageWindow(page: number, total: number): number[] {
  if (total <= 5) return Array.from({ length: total }, (_, i) => i + 1)
  if (page <= 3) return [1, 2, 3, 4, 5]
  if (page >= total - 2) return [total - 4, total - 3, total - 2, total - 1, total]
  return [page - 2, page - 1, page, page + 1, page + 2]
}

function regionName(id: string): string {
  return REGIONS.find(r => String(r.id) === id)?.name ?? id
}

// ── Component ────────────────────────────────────────────────────────────────

const EMPTY_FILTERS: Filters = {
  producto: '', region: '', subsector: '', grupo: '', tipoMonitoreo: '', mercado: '',
}

export default function App() {
  // Panel selectors
  const [tipoPrecio, setTipoPrecio] = useState<TipoPrecio>('mayorista')
  const [anio, setAnio] = useState<Anio>(2026)

  // All filter values in one object (drives both panel inputs and buildUrl)
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS)

  // Result state
  const [records, setRecords] = useState<PriceRecord[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hasSearched, setHasSearched] = useState(false)
  const [sortDir, setSortDir] = useState<'desc' | 'asc'>('desc')
  const [resultTipo, setResultTipo] = useState<TipoPrecio>('mayorista')

  // ── Fetch ──────────────────────────────────────────────────────────────────

  const buildUrl = (pageNum: number, sort: 'desc' | 'asc', tipo: TipoPrecio, f: Filters): string => {
    const params = new URLSearchParams({
      resource_id: RESOURCE_IDS[tipo][anio],
      limit: String(PAGE_SIZE),
      offset: String((pageNum - 1) * PAGE_SIZE),
    })
    if (f.producto.trim()) params.set('q', JSON.stringify({ Producto: f.producto.trim() }))

    const apiFilters: Record<string, string | number> = {}
    if (tipo === 'mayorista' && f.subsector)       apiFilters['Subsector'] = f.subsector
    if (tipo === 'mayorista' && f.mercado)          apiFilters['Mercado'] = f.mercado
    if (tipo === 'consumidor' && f.grupo)           apiFilters['Grupo'] = f.grupo
    if (tipo === 'consumidor' && f.tipoMonitoreo)   apiFilters['Tipo de punto monitoreo'] = f.tipoMonitoreo
    if (f.region)                                   apiFilters['ID region'] = Number(f.region)
    if (Object.keys(apiFilters).length > 0) params.set('filters', JSON.stringify(apiFilters))

    params.set('sort', `${SORT_FIELD[tipo]} ${sort}`)
    return `${API_BASE}?${params.toString()}`
  }

  const fetchData = async (
    pageNum: number,
    sort: 'desc' | 'asc' = sortDir,
    tipo: TipoPrecio = resultTipo,
    overrides: Partial<Filters> = {},
  ) => {
    const f: Filters = { ...filters, ...overrides }
    if (Object.keys(overrides).length > 0) setFilters(f)

    setLoading(true)
    setError(null)
    try {
      const res = await fetch(buildUrl(pageNum, sort, tipo, f))
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data: ApiResponse = await res.json()
      setRecords(data.result.records)
      setTotal(data.result.total)
      setPage(pageNum)
      setResultTipo(tipo)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error de conexión')
    } finally {
      setLoading(false)
    }
  }

  const handleSearch = () => {
    setHasSearched(true)
    fetchData(1, sortDir, tipoPrecio)
  }

  const toggleSort = () => {
    const next = sortDir === 'desc' ? 'asc' : 'desc'
    setSortDir(next)
    fetchData(page, next, resultTipo)
  }

  const handleTipoChange = (next: TipoPrecio) => {
    setTipoPrecio(next)
    setFilters(f => ({ ...f, subsector: '', grupo: '', tipoMonitoreo: '', mercado: '' }))
  }

  // Called when user clicks a filterable cell in the table
  const applyFromCell = (overrides: Partial<Filters>) => {
    setHasSearched(true)
    setTipoPrecio(resultTipo) // keep panel in sync
    fetchData(1, sortDir, resultTipo, overrides)
  }

  const clearFilter = (key: keyof Filters) => {
    fetchData(1, sortDir, resultTipo, { [key]: '' })
  }

  // ── Derived ────────────────────────────────────────────────────────────────

  const stats = (() => {
    if (!records.length) return null
    const avgs = records.map(r => parsePrice(r['Precio promedio'])).filter(Boolean)
    const mins = records.map(r => parsePrice(r['Precio minimo'])).filter(Boolean)
    const maxs = records.map(r => parsePrice(r['Precio maximo'])).filter(Boolean)
    return {
      avg: avgs.length ? avgs.reduce((a, b) => a + b) / avgs.length : 0,
      min: mins.length ? Math.min(...mins) : 0,
      max: maxs.length ? Math.max(...maxs) : 0,
    }
  })()

  const totalPages = Math.ceil(total / PAGE_SIZE)
  const from = (page - 1) * PAGE_SIZE + 1
  const to = Math.min(page * PAGE_SIZE, total)

  // Active filter chips (only non-empty values)
  const activeChips: { key: keyof Filters; label: string; value: string }[] = [
    filters.producto    && { key: 'producto',      label: 'Producto',        value: filters.producto },
    filters.region      && { key: 'region',         label: 'Región',          value: regionName(filters.region) },
    filters.subsector   && { key: 'subsector',      label: 'Subsector',       value: filters.subsector },
    filters.grupo       && { key: 'grupo',           label: 'Grupo',           value: filters.grupo },
    filters.tipoMonitoreo && { key: 'tipoMonitoreo', label: 'Punto',          value: filters.tipoMonitoreo },
    filters.mercado     && { key: 'mercado',         label: 'Mercado',         value: filters.mercado },
  ].filter(Boolean) as { key: keyof Filters; label: string; value: string }[]

  // Shared class for clickable cell content
  const cellBtn = 'cursor-pointer hover:text-green-700 hover:underline underline-offset-2 transition-colors'

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen flex flex-col bg-gray-50">

      {/* Header */}
      <header className="bg-green-700 text-white shadow-lg">
        <div className="container mx-auto px-4 py-4 flex items-center gap-3">
          <span className="text-4xl">🥦</span>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Consultas ODEPA</h1>
            <p className="text-green-200 text-sm">
              Precios mayoristas y consumidor de frutas y hortalizas en Chile
            </p>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-6 flex-1">

        {/* ── Filter panel ── */}
        <div className="card bg-white shadow-md mb-6">
          <div className="card-body">
            <h2 className="card-title text-green-800 mb-1 text-base">
              <Search size={16} />
              Filtros de búsqueda
            </h2>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mt-2">

              <div className="form-control">
                <label className="label py-1">
                  <span className="label-text font-semibold">Tipo de precio</span>
                </label>
                <select
                  className="select select-bordered select-sm"
                  value={tipoPrecio}
                  onChange={e => handleTipoChange(e.target.value as TipoPrecio)}
                >
                  <option value="mayorista">Mayorista</option>
                  <option value="consumidor">Consumidor</option>
                </select>
              </div>

              <div className="form-control">
                <label className="label py-1">
                  <span className="label-text font-semibold">Año</span>
                </label>
                <select
                  className="select select-bordered select-sm"
                  value={anio}
                  onChange={e => setAnio(Number(e.target.value) as Anio)}
                >
                  <option value={2026}>2026</option>
                  <option value={2025}>2025</option>
                  <option value={2024}>2024</option>
                </select>
              </div>

              {tipoPrecio === 'mayorista' ? (
                <div className="form-control">
                  <label className="label py-1">
                    <span className="label-text font-semibold">Subsector</span>
                  </label>
                  <select
                    className="select select-bordered select-sm"
                    value={filters.subsector}
                    onChange={e => setFilters(f => ({ ...f, subsector: e.target.value }))}
                  >
                    <option value="">Todos</option>
                    <option value="Frutas">Frutas</option>
                    <option value="Hortalizas y tubérculos">Hortalizas y tubérculos</option>
                  </select>
                </div>
              ) : (
                <div className="form-control">
                  <label className="label py-1">
                    <span className="label-text font-semibold">Grupo</span>
                  </label>
                  <select
                    className="select select-bordered select-sm"
                    value={filters.grupo}
                    onChange={e => setFilters(f => ({ ...f, grupo: e.target.value }))}
                  >
                    <option value="">Todos</option>
                    {GRUPOS_CONSUMIDOR.map(g => (
                      <option key={g} value={g}>{g}</option>
                    ))}
                  </select>
                </div>
              )}

              {tipoPrecio === 'consumidor' && (
                <div className="form-control">
                  <label className="label py-1">
                    <span className="label-text font-semibold">Punto de monitoreo</span>
                  </label>
                  <select
                    className="select select-bordered select-sm"
                    value={filters.tipoMonitoreo}
                    onChange={e => setFilters(f => ({ ...f, tipoMonitoreo: e.target.value }))}
                  >
                    <option value="">Todos</option>
                    {TIPOS_MONITOREO.map(t => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                </div>
              )}

              <div className="form-control">
                <label className="label py-1">
                  <span className="label-text font-semibold">Región</span>
                </label>
                <select
                  className="select select-bordered select-sm"
                  value={filters.region}
                  onChange={e => setFilters(f => ({ ...f, region: e.target.value }))}
                >
                  <option value="">Todas las regiones</option>
                  {REGIONS.map(r => (
                    <option key={r.id} value={String(r.id)}>{r.name}</option>
                  ))}
                </select>
              </div>

              <div className="form-control lg:col-span-2">
                <label className="label py-1">
                  <span className="label-text font-semibold">Producto</span>
                  <span className="label-text-alt text-gray-400">Presiona Enter para buscar</span>
                </label>
                <input
                  type="text"
                  placeholder={
                    tipoPrecio === 'mayorista'
                      ? 'Ej: manzana, tomate, palta, uva...'
                      : 'Ej: tomate, lechuga, manzana...'
                  }
                  className="input input-bordered input-sm"
                  value={filters.producto}
                  onChange={e => setFilters(f => ({ ...f, producto: e.target.value }))}
                  onKeyDown={e => e.key === 'Enter' && handleSearch()}
                />
              </div>
            </div>

            <div className="card-actions justify-end mt-3">
              <button
                className="btn btn-success text-white gap-2"
                onClick={handleSearch}
                disabled={loading}
              >
                {loading
                  ? <span className="loading loading-spinner loading-sm" />
                  : <Search size={16} />}
                Consultar
              </button>
            </div>
          </div>
        </div>

        {/* ── Loading ── */}
        {loading && (
          <div className="flex justify-center py-20">
            <span className="loading loading-spinner loading-lg text-green-700" />
          </div>
        )}

        {/* ── Error ── */}
        {!loading && error && (
          <div role="alert" className="alert alert-error mb-4 flex-wrap">
            <span>Error al cargar los datos: {error}</span>
            <button className="btn btn-sm btn-ghost gap-1" onClick={() => fetchData(page, sortDir, resultTipo)}>
              <RefreshCw size={14} />
              Reintentar
            </button>
          </div>
        )}

        {/* ── Initial state ── */}
        {!loading && !error && !hasSearched && (
          <div className="flex flex-col items-center justify-center py-24 text-gray-400 select-none">
            <span className="text-7xl mb-5">🥕</span>
            <p className="text-xl font-semibold text-gray-500">Consulta precios agrícolas</p>
            <p className="text-sm mt-2 text-center max-w-sm">
              Selecciona los filtros y presiona{' '}
              <strong className="text-gray-600">Consultar</strong>{' '}
              para ver datos de la API de ODEPA
            </p>
          </div>
        )}

        {/* ── Empty state ── */}
        {!loading && !error && hasSearched && records.length === 0 && (
          <div className="flex flex-col items-center justify-center py-24 text-gray-400">
            <Package size={64} strokeWidth={1.5} className="mb-4" />
            <p className="text-xl font-semibold text-gray-500">Sin resultados</p>
            <p className="text-sm mt-2">Intenta con otros filtros de búsqueda</p>
          </div>
        )}

        {/* ── Results ── */}
        {!loading && !error && records.length > 0 && (
          <>
            {/* Stats cards */}
            {stats && (
              <div className="grid grid-cols-2 xl:grid-cols-4 gap-3 mb-4">
                {([
                  { label: 'Total registros',       value: total.toLocaleString('es-CL'), mono: false },
                  { label: 'Precio promedio (pág.)', value: formatCLP(stats.avg), mono: true },
                  { label: 'Precio mínimo (pág.)',   value: formatCLP(stats.min), mono: true },
                  { label: 'Precio máximo (pág.)',   value: formatCLP(stats.max), mono: true },
                ] as const).map(({ label, value, mono }) => (
                  <div key={label} className="bg-white rounded-xl shadow p-4 border border-gray-100">
                    <p className="text-xs text-gray-500 mb-1 uppercase tracking-wide">{label}</p>
                    <p className={`text-xl font-bold text-green-700 ${mono ? 'font-mono' : ''}`}>{value}</p>
                  </div>
                ))}
              </div>
            )}

            {/* Active filter chips */}
            {activeChips.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 mb-3">
                <span className="text-xs text-gray-400 uppercase tracking-wide">Filtrando por:</span>
                {activeChips.map(({ key, label, value }) => (
                  <span
                    key={key}
                    className="inline-flex items-center gap-1 bg-green-100 text-green-800 text-xs font-medium px-2.5 py-1 rounded-full border border-green-200"
                  >
                    <span className="text-green-500 font-normal">{label}:</span>
                    {value}
                    <button
                      className="ml-0.5 hover:text-red-500 transition-colors"
                      onClick={() => clearFilter(key)}
                      title={`Quitar filtro ${label}`}
                    >
                      <X size={11} />
                    </button>
                  </span>
                ))}
                {activeChips.length > 1 && (
                  <button
                    className="text-xs text-gray-400 hover:text-red-500 underline underline-offset-2 transition-colors"
                    onClick={() => fetchData(1, sortDir, resultTipo, EMPTY_FILTERS)}
                  >
                    Limpiar todo
                  </button>
                )}
              </div>
            )}

            {/* Table */}
            <div className="card bg-white shadow-md overflow-hidden border border-gray-100">
              <div className="overflow-x-auto">
                <table className="table table-zebra table-sm w-full">
                  <thead>
                    <tr className="bg-green-700 text-white [&>th]:text-white [&>th]:font-semibold">
                      <th>
                        <button
                          className="flex items-center gap-1 hover:opacity-80 transition-opacity"
                          onClick={toggleSort}
                          title="Ordenar por fecha"
                        >
                          {resultTipo === 'consumidor' ? 'Fecha inicio' : 'Fecha'}
                          {sortDir === 'desc' ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
                        </button>
                      </th>
                      {resultTipo === 'consumidor' && <th>Fecha término</th>}
                      <th>Producto</th>
                      {resultTipo === 'mayorista' && <th>Variedad</th>}
                      {resultTipo === 'mayorista' && <th>Calidad</th>}
                      {resultTipo === 'mayorista' ? <th>Mercado</th> : <th>Sector</th>}
                      {resultTipo === 'consumidor' && <th>Grupo</th>}
                      {resultTipo === 'consumidor' && <th>Punto monitoreo</th>}
                      <th>Región</th>
                      <th>{resultTipo === 'consumidor' ? 'Unidad' : 'Unidad comerc.'}</th>
                      <th className="text-right">Precio mín.</th>
                      <th className="text-right">Precio máx.</th>
                      <th className="text-right">Precio prom.</th>
                      {resultTipo === 'mayorista' && <th className="text-right">Volumen</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {resultTipo === 'mayorista'
                      ? (records as MayoristaRecord[]).map(r => (
                          <tr key={r._id} className="hover">
                            <td className="whitespace-nowrap text-xs text-gray-500">{r.Fecha}</td>
                            <td
                              className={`font-semibold text-sm ${cellBtn}`}
                              onClick={() => applyFromCell({ producto: r.Producto })}
                              title="Filtrar por este producto"
                            >
                              {r.Producto}
                            </td>
                            <td className="text-sm">{r['Variedad / Tipo'] || '—'}</td>
                            <td className="text-sm">{r.Calidad || '—'}</td>
                            <td
                              className={`text-sm ${cellBtn}`}
                              onClick={() => applyFromCell({ mercado: r.Mercado })}
                              title="Filtrar por este mercado"
                            >
                              {r.Mercado}
                            </td>
                            <td
                              className={`text-sm whitespace-nowrap ${cellBtn}`}
                              onClick={() => applyFromCell({ region: r['ID region'] })}
                              title="Filtrar por esta región"
                            >
                              {r.Region}
                            </td>
                            <td className="text-xs text-gray-600">{r['Unidad de comercializacion']}</td>
                            <td className="text-right font-mono text-sm text-green-700">{formatPrice(r['Precio minimo'])}</td>
                            <td className="text-right font-mono text-sm text-green-700">{formatPrice(r['Precio maximo'])}</td>
                            <td className="text-right font-mono text-sm text-green-700 font-bold">{formatPrice(r['Precio promedio'])}</td>
                            <td className="text-right text-sm">{r.Volumen || '—'}</td>
                          </tr>
                        ))
                      : (records as ConsumidorRecord[]).map(r => (
                          <tr key={r._id} className="hover">
                            <td className="whitespace-nowrap text-xs text-gray-500">{r['Fecha inicio']}</td>
                            <td className="whitespace-nowrap text-xs text-gray-500">{r['Fecha termino']}</td>
                            <td
                              className={`font-semibold text-sm ${cellBtn}`}
                              onClick={() => applyFromCell({ producto: r.Producto.split('|')[0].trim() })}
                              title="Filtrar por este producto"
                            >
                              {r.Producto}
                            </td>
                            <td className="text-sm">{r.Sector || '—'}</td>
                            <td
                              className={`text-sm ${cellBtn}`}
                              onClick={() => applyFromCell({ grupo: r.Grupo })}
                              title="Filtrar por este grupo"
                            >
                              {r.Grupo || '—'}
                            </td>
                            <td
                              className={`text-sm ${cellBtn}`}
                              onClick={() => applyFromCell({ tipoMonitoreo: r['Tipo de punto monitoreo'] })}
                              title="Filtrar por tipo de punto"
                            >
                              {r['Tipo de punto monitoreo'] || '—'}
                            </td>
                            <td
                              className={`text-sm whitespace-nowrap ${cellBtn}`}
                              onClick={() => applyFromCell({ region: r['ID region'] })}
                              title="Filtrar por esta región"
                            >
                              {r.Region}
                            </td>
                            <td className="text-xs text-gray-600">{r.Unidad}</td>
                            <td className="text-right font-mono text-sm text-green-700">{formatPrice(r['Precio minimo'])}</td>
                            <td className="text-right font-mono text-sm text-green-700">{formatPrice(r['Precio maximo'])}</td>
                            <td className="text-right font-mono text-sm text-green-700 font-bold">{formatPrice(r['Precio promedio'])}</td>
                          </tr>
                        ))
                    }
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              <div className="flex flex-col sm:flex-row justify-between items-center gap-3 px-4 py-3 border-t bg-gray-50">
                <span className="text-sm text-gray-500">
                  {from.toLocaleString('es-CL')}–{to.toLocaleString('es-CL')} de{' '}
                  <strong>{total.toLocaleString('es-CL')}</strong> registros
                </span>
                <div className="join">
                  <button className="join-item btn btn-sm" disabled={page <= 1}
                    onClick={() => fetchData(page - 1, sortDir, resultTipo)}>«</button>
                  {pageWindow(page, totalPages).map(p => (
                    <button
                      key={p}
                      className={`join-item btn btn-sm ${p === page ? 'btn-success text-white' : ''}`}
                      onClick={() => fetchData(p, sortDir, resultTipo)}
                    >{p}</button>
                  ))}
                  <button className="join-item btn btn-sm" disabled={page >= totalPages}
                    onClick={() => fetchData(page + 1, sortDir, resultTipo)}>»</button>
                </div>
              </div>
            </div>
          </>
        )}
      </main>

      <footer className="bg-green-800 text-green-200 text-center py-3 text-sm mt-8">
        Datos obtenidos desde{' '}
        <a href="https://datos.odepa.gob.cl" target="_blank" rel="noopener noreferrer"
          className="underline underline-offset-2 hover:text-white transition-colors">
          datos.odepa.gob.cl
        </a>
        {' '}· ODEPA – Ministerio de Agricultura de Chile
      </footer>

    </div>
  )
}
