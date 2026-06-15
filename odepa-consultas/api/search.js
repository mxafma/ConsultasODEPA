const ODEPA_BASE = 'https://datos.odepa.gob.cl/es/api/action/datastore_search'
const PAGE = 32000          // CKAN's max rows per request
const MAX_PAGES = 30        // safety cap

// CKAN's `distinct=true` is applied *after* the row limit, so a single call
// only returns the distinct values found within the first `limit` rows.
// To get the full catalogue we scan the whole table in `PAGE`-sized windows
// (offset stepping) and union the distinct values found in each window.
async function fetchCatalog(resourceId, field) {
  const head = await fetch(
    `${ODEPA_BASE}?${new URLSearchParams({ resource_id: resourceId, limit: '0' })}`,
  ).then(r => r.json())
  const totalRows = head?.result?.total ?? 0
  const pages = Math.min(MAX_PAGES, Math.ceil(totalRows / PAGE)) || 1

  const requests = Array.from({ length: pages }, (_, i) => {
    const p = new URLSearchParams({
      resource_id: resourceId,
      fields: field,
      distinct: 'true',
      limit: String(PAGE),
      offset: String(i * PAGE),
    })
    return fetch(`${ODEPA_BASE}?${p}`).then(r => r.json())
  })

  const values = new Set()
  for (const data of await Promise.all(requests)) {
    for (const rec of data?.result?.records ?? []) {
      if (rec[field]) values.add(rec[field])
    }
  }
  return [...values].sort((a, b) => a.localeCompare(b, 'es'))
}

export default async function handler(req, res) {
  // ── Catalogue mode: return all distinct values of a field for a resource ──
  if (req.query.catalog) {
    const field = String(req.query.catalog)
    const resourceId = String(req.query.resource_id || '')
    if (!resourceId) {
      return res.status(400).json({ error: 'resource_id is required' })
    }
    try {
      const values = await fetchCatalog(resourceId, field)
      res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800')
      return res.status(200).json({ values })
    } catch (err) {
      return res.status(502).json({ error: String(err) })
    }
  }

  // ── Transparent proxy for datastore_search ──
  const params = new URLSearchParams()
  for (const [key, val] of Object.entries(req.query)) {
    params.set(key, String(val))
  }

  const url = `${ODEPA_BASE}?${params}`

  try {
    const upstream = await fetch(url)
    const data = await upstream.json()
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300')
    res.status(upstream.status).json(data)
  } catch (err) {
    res.status(502).json({ error: String(err) })
  }
}
