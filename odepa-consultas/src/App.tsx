import { lazy, Suspense, useState, useRef } from 'react'
import { Package, Search, RefreshCw, ChevronUp, ChevronDown, X, LineChart } from 'lucide-react'

// Lazy-loaded so the charting library (recharts) is only fetched when a user
// actually opens the product detail modal, keeping the initial bundle small.
const ProductDetailModal = lazy(() => import('./components/ProductDetailModal'))
import {
  type TipoPrecio, type Anio, type Filters,
  type MayoristaRecord, type ConsumidorRecord, type PriceRecord, type ApiResponse,
  type PriceBasis, type NormalizedPrice,
  RESOURCE_IDS, SORT_FIELD, TIPOS_MONITOREO, GRUPOS_CONSUMIDOR, REGIONS, PAGE_SIZE, API_BASE,
  formatCLP, formatPrice, pageWindow, regionName,
  getCatalog, matchProducts, normalizedPrice, unitToKilos, unitToPieces, basisLabel, basisSuffix,
  baseProductName,
} from './lib/odepa'

// ── Helpers ──────────────────────────────────────────────────────────────────

const STATS_LIMIT = 2000

interface Stats {
  basis: PriceBasis
  comparable: number
  avg: number
  min: number
  max: number
}

function computeStats(recs: PriceRecord[], tipo: TipoPrecio): Stats | null {
  if (!recs.length) return null
  const getUnit = (r: PriceRecord): string =>
    tipo === 'mayorista'
      ? (r as MayoristaRecord)['Unidad de comercializacion']
      : (r as ConsumidorRecord).Unidad
  const norms = recs
    .map(r => normalizedPrice(r['Precio promedio'], getUnit(r)))
    .filter((n): n is NormalizedPrice => n != null)
  if (!norms.length) return null
  const kgCount = norms.filter(n => n.basis === 'kg').length
  const basis: PriceBasis = kgCount >= norms.length - kgCount ? 'kg' : 'u'
  const vals = (field: 'Precio promedio' | 'Precio minimo' | 'Precio maximo') =>
    recs
      .map(r => normalizedPrice(r[field], getUnit(r)))
      .filter((n): n is NormalizedPrice => n != null && n.basis === basis && n.value > 0)
      .map(n => n.value)
  const avgs = vals('Precio promedio')
  const mins = vals('Precio minimo')
  const maxs = vals('Precio maximo')
  return {
    basis,
    comparable: avgs.length,
    avg: avgs.length ? avgs.reduce((a, b) => a + b) / avgs.length : 0,
    min: mins.length ? Math.min(...mins) : 0,
    max: maxs.length ? Math.max(...maxs) : 0,
  }
}

// ── Component ────────────────────────────────────────────────────────────────

const EMPTY_FILTERS: Filters = {
  producto: '', region: '', subsector: '', grupo: '', tipoMonitoreo: '', mercado: '',
  variedad: '', calidad: '', sector: '',
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

  // Product opened in the detail modal (trend + margin), by base name.
  const [detailProduct, setDetailProduct] = useState<string | null>(null)

  // Global stats: fetched for the full result set when total ≤ STATS_LIMIT.
  const [globalStats, setGlobalStats] = useState<Stats | null>(null)
  const statsGenRef = useRef(0)

  // ── Fetch ──────────────────────────────────────────────────────────────────

  const buildUrl = (
    pageNum: number,
    sort: 'desc' | 'asc',
    tipo: TipoPrecio,
    f: Filters,
    productMatches: string[] | null,
  ): string => {
    const params = new URLSearchParams({
      resource_id: RESOURCE_IDS[tipo][anio],
      limit: String(PAGE_SIZE),
      offset: String((pageNum - 1) * PAGE_SIZE),
    })

    const apiFilters: Record<string, string | number | string[]> = {}
    if (productMatches && productMatches.length)    apiFilters['Producto'] = productMatches
    if (tipo === 'mayorista' && f.subsector)       apiFilters['Subsector'] = f.subsector
    if (tipo === 'mayorista' && f.mercado)          apiFilters['Mercado'] = f.mercado
    if (tipo === 'mayorista' && f.variedad)         apiFilters['Variedad / Tipo'] = f.variedad
    if (tipo === 'mayorista' && f.calidad)          apiFilters['Calidad'] = f.calidad
    if (tipo === 'consumidor' && f.grupo)           apiFilters['Grupo'] = f.grupo
    if (tipo === 'consumidor' && f.tipoMonitoreo)   apiFilters['Tipo de punto monitoreo'] = f.tipoMonitoreo
    if (tipo === 'consumidor' && f.sector)          apiFilters['Sector'] = f.sector
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
      // Resolve the product term to matching catalogue names (accent/partial).
      let productMatches: string[] | null = null
      const term = f.producto.trim()
      if (term) {
        const catalog = await getCatalog(RESOURCE_IDS[tipo][anio])
        productMatches = matchProducts(catalog, term)
        if (productMatches.length === 0) {
          // Nothing in the catalogue matches → no results, skip the API call.
          setRecords([])
          setTotal(0)
          setPage(pageNum)
          setResultTipo(tipo)
          return
        }
      }

      const res = await fetch(buildUrl(pageNum, sort, tipo, f, productMatches))
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data: ApiResponse = await res.json()
      setRecords(data.result.records)
      setTotal(data.result.total)
      setPage(pageNum)
      setResultTipo(tipo)

      // ── Global stats (background fetch, page 1 only) ──────────────────────
      if (pageNum === 1) {
        setGlobalStats(null)
        if (data.result.total > 0 && data.result.total <= STATS_LIMIT) {
          const gen = ++statsGenRef.current
          const statsFields = tipo === 'mayorista'
            ? 'Precio promedio,Precio minimo,Precio maximo,Unidad de comercializacion'
            : 'Precio promedio,Precio minimo,Precio maximo,Unidad'
          const sp = new URLSearchParams({
            resource_id: RESOURCE_IDS[tipo][anio],
            limit: String(data.result.total),
            offset: '0',
            fields: statsFields,
          })
          const sf: Record<string, string | number | string[]> = {}
          if (productMatches && productMatches.length)  sf['Producto'] = productMatches
          if (tipo === 'mayorista' && f.subsector)      sf['Subsector'] = f.subsector
          if (tipo === 'mayorista' && f.mercado)         sf['Mercado'] = f.mercado
          if (tipo === 'mayorista' && f.variedad)        sf['Variedad / Tipo'] = f.variedad
          if (tipo === 'mayorista' && f.calidad)         sf['Calidad'] = f.calidad
          if (tipo === 'consumidor' && f.grupo)          sf['Grupo'] = f.grupo
          if (tipo === 'consumidor' && f.tipoMonitoreo)  sf['Tipo de punto monitoreo'] = f.tipoMonitoreo
          if (tipo === 'consumidor' && f.sector)         sf['Sector'] = f.sector
          if (f.region)                                  sf['ID region'] = Number(f.region)
          if (Object.keys(sf).length) sp.set('filters', JSON.stringify(sf))
          fetch(`${API_BASE}?${sp}`)
            .then(r => r.json())
            .then((d: ApiResponse) => {
              if (gen !== statsGenRef.current) return
              setGlobalStats(computeStats(d.result.records, tipo))
            })
            .catch(() => {})
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error de conexión')
    } finally {
      setLoading(false)
    }
  }

  const handleSearch = () => {
    setHasSearched(true)
    fetchData(1, sortDir, tipoPrecio, { variedad: '', calidad: '', sector: '' })
  }

  const toggleSort = () => {
    const next = sortDir === 'desc' ? 'asc' : 'desc'
    setSortDir(next)
    fetchData(page, next, resultTipo)
  }

  const handleTipoChange = (next: TipoPrecio) => {
    setTipoPrecio(next)
    setFilters(f => ({ ...f, subsector: '', grupo: '', tipoMonitoreo: '', mercado: '', variedad: '', calidad: '', sector: '' }))
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

  // Commercialization unit for a record (differs by tipo); used in renderCompCell.
  const unitOf = (r: PriceRecord): string =>
    resultTipo === 'mayorista'
      ? (r as MayoristaRecord)['Unidad de comercializacion']
      : (r as ConsumidorRecord).Unidad

  // Page-level stats (fallback when global stats aren't available).
  const stats = computeStats(records, resultTipo)
  // Prefer global stats (full result set) when available.
  const displayStats = globalStats ?? stats
  const isGlobal = globalStats != null

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
    filters.variedad    && { key: 'variedad',        label: 'Variedad',        value: filters.variedad },
    filters.calidad     && { key: 'calidad',         label: 'Calidad',         value: filters.calidad },
    filters.sector      && { key: 'sector',          label: 'Sector',          value: filters.sector },
  ].filter(Boolean) as { key: keyof Filters; label: string; value: string }[]

  // Shared class for clickable cell content
  const cellBtn = 'cursor-pointer hover:text-green-700 hover:underline underline-offset-2 transition-colors'

  // Comparable-price cell: $/kg when the unit has weight, else $/u (per piece),
  // with the conversion shown on hover.
  const renderCompCell = (price: string, unit: string) => {
    const np = normalizedPrice(price, unit)
    const divisor = np?.basis === 'kg' ? unitToKilos(unit) : unitToPieces(unit)
    const noun = np?.basis === 'kg' ? 'kg' : 'u'
    return (
      <td
        className="text-right font-mono text-sm text-green-800 font-semibold whitespace-nowrap"
        title={np ? `${formatPrice(price)} ÷ ${divisor} ${noun}` : 'Sin precio comparable (volumen/litro)'}
      >
        {np
          ? <>{formatCLP(np.value)}<span className="text-gray-400 text-xs">{basisSuffix(np.basis)}</span></>
          : '—'}
      </td>
    )
  }

  // Product name cell: name (click = filter) + chart icon (click = detail modal).
  const renderProductCell = (fullName: string, base: string) => (
    <td className="font-semibold text-sm">
      <div className="flex items-center gap-1.5">
        <span className={cellBtn} onClick={() => applyFromCell({ producto: base })} title="Filtrar por este producto">
          {fullName}
        </span>
        <button
          type="button"
          className="shrink-0 text-gray-300 hover:text-green-700 transition-colors"
          onClick={() => setDetailProduct(base)}
          title="Ver tendencia y margen $/kg"
        >
          <LineChart size={14} />
        </button>
      </div>
    </td>
  )

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
                  <span className="label-text-alt text-gray-400">Sin tildes y parcial · Enter para buscar</span>
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
            {/* Stats cards (comparable price: $/kg or $/u) */}
            {displayStats && (
              <>
                <div className="grid grid-cols-2 xl:grid-cols-4 gap-3 mb-1">
                  {([
                    { label: 'Total registros',                                      value: total.toLocaleString('es-CL'),                   mono: false },
                    { label: `${basisLabel(displayStats.basis)} promedio${isGlobal ? '' : ' (pág.)'}`, value: displayStats.avg ? formatCLP(displayStats.avg) : '—', mono: true },
                    { label: `${basisLabel(displayStats.basis)} mínimo${isGlobal ? '' : ' (pág.)'}`,   value: displayStats.min ? formatCLP(displayStats.min) : '—', mono: true },
                    { label: `${basisLabel(displayStats.basis)} máximo${isGlobal ? '' : ' (pág.)'}`,   value: displayStats.max ? formatCLP(displayStats.max) : '—', mono: true },
                  ] as const).map(({ label, value, mono }) => (
                    <div key={label} className="bg-white rounded-xl shadow p-4 border border-gray-100">
                      <p className="text-xs text-gray-500 mb-1 uppercase tracking-wide">{label}</p>
                      <p className={`text-xl font-bold text-green-700 ${mono ? 'font-mono' : ''}`}>{value}</p>
                    </div>
                  ))}
                </div>
                <p className="text-xs text-gray-400 mb-4">
                  {basisLabel(displayStats.basis)} estimado sobre {displayStats.comparable}{' '}
                  {isGlobal
                    ? `de ${total.toLocaleString('es-CL')} registros`
                    : `de ${records.length} filas de la página${total > STATS_LIMIT ? ` — más de ${STATS_LIMIT.toLocaleString('es-CL')} registros, estadísticas parciales` : ''}`}
                  {displayStats.basis === 'u' ? ' (producto vendido por unidad)' : ' con unidad convertible'}.
                </p>
              </>
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
                      <th className="text-right" title="Precio comparable: por kilo ($/kg) o por unidad ($/u)">$/kg · $/u</th>
                      {resultTipo === 'mayorista' && <th className="text-right">Volumen</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {resultTipo === 'mayorista'
                      ? (records as MayoristaRecord[]).map(r => (
                          <tr key={r._id} className="hover">
                            <td className="whitespace-nowrap text-xs text-gray-500">{r.Fecha}</td>
                            {renderProductCell(r.Producto, r.Producto)}
                            <td
                              className={`text-sm ${r['Variedad / Tipo'] ? cellBtn : ''}`}
                              onClick={() => r['Variedad / Tipo'] && applyFromCell({ variedad: r['Variedad / Tipo'] })}
                              title={r['Variedad / Tipo'] ? 'Filtrar por esta variedad' : undefined}
                            >
                              {r['Variedad / Tipo'] || '—'}
                            </td>
                            <td
                              className={`text-sm ${r.Calidad ? cellBtn : ''}`}
                              onClick={() => r.Calidad && applyFromCell({ calidad: r.Calidad })}
                              title={r.Calidad ? 'Filtrar por esta calidad' : undefined}
                            >
                              {r.Calidad || '—'}
                            </td>
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
                            {renderCompCell(r['Precio promedio'], r['Unidad de comercializacion'])}
                            <td className="text-right text-sm">{r.Volumen || '—'}</td>
                          </tr>
                        ))
                      : (records as ConsumidorRecord[]).map(r => (
                          <tr key={r._id} className="hover">
                            <td className="whitespace-nowrap text-xs text-gray-500">{r['Fecha inicio']}</td>
                            <td className="whitespace-nowrap text-xs text-gray-500">{r['Fecha termino']}</td>
                            {renderProductCell(r.Producto, baseProductName(r.Producto))}
                            <td
                              className={`text-sm ${r.Sector ? cellBtn : ''}`}
                              onClick={() => r.Sector && applyFromCell({ sector: r.Sector })}
                              title={r.Sector ? 'Filtrar por este sector' : undefined}
                            >
                              {r.Sector || '—'}
                            </td>
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
                            {renderCompCell(r['Precio promedio'], r.Unidad)}
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

      {/* Product detail modal (trend + mayorista vs consumidor) */}
      {detailProduct && (
        <Suspense fallback={
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
            <span className="loading loading-spinner loading-lg text-white" />
          </div>
        }>
          <ProductDetailModal
            product={detailProduct}
            anio={anio}
            region={filters.region || undefined}
            subsector={resultTipo === 'mayorista' ? (filters.subsector || undefined) : undefined}
            regionLabel={filters.region ? regionName(filters.region) : undefined}
            onClose={() => setDetailProduct(null)}
          />
        </Suspense>
      )}

    </div>
  )
}
