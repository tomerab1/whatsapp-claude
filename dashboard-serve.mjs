// dashboard-serve.mjs — pm2 entry for the live dashboard server. Importing dashboard.mjs
// is side-effect-free (its CLI guard only fires when it's the entry file), so we just
// call serveDashboard() explicitly. Port: argv[2] or 8199. Refresh: DASH_REFRESH_SEC.
import { serveDashboard } from './dashboard.mjs'

const port = Number(process.argv[2]) || undefined
const refreshMs = (Number(process.env.DASH_REFRESH_SEC) || 15) * 1000
serveDashboard(port, refreshMs)
