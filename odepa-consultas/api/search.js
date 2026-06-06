export default async function handler(req, res) {
  const params = new URLSearchParams()
  for (const [key, val] of Object.entries(req.query)) {
    params.set(key, String(val))
  }

  const url = `https://datos.odepa.gob.cl/es/api/action/datastore_search?${params}`

  try {
    const upstream = await fetch(url)
    const data = await upstream.json()
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300')
    res.status(upstream.status).json(data)
  } catch (err) {
    res.status(502).json({ error: String(err) })
  }
}
