import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import handler from './api/search.js'

// Dev-only middleware: run the real serverless handler (api/search.js) for
// /api/search so the dev server behaves like Vercel — including the `catalog`
// mode used by accent-insensitive product search and the detail modal. Vite's
// plain path-rewrite proxy can't run that logic.
function apiSearchDev() {
  return {
    name: 'api-search-dev',
    configureServer(server: any) {
      server.middlewares.use('/api/search', async (req: any, res: any) => {
        const url = new URL(req.originalUrl || req.url || '/', 'http://localhost')
        const query = Object.fromEntries(url.searchParams.entries())
        const shim = {
          _code: 200,
          setHeader: (k: string, v: string) => res.setHeader(k, v),
          status(code: number) { this._code = code; return this },
          json(body: unknown) {
            res.statusCode = this._code
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify(body))
          },
        }
        try {
          await handler({ query }, shim)
        } catch (err) {
          res.statusCode = 502
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ error: String(err) }))
        }
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), apiSearchDev()],
  server: { port: 5174 },
})
