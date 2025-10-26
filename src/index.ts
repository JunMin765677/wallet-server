import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import pino from 'pino'
import { prisma } from './db'
import issuerRouter from './routes/issuer'   // ⬅️ 新增
import verifierRouter from './routes/verifier'


const app = express()
const logger = pino({ level: process.env.NODE_ENV === 'production' ? 'info' : 'debug' })

app.use(cors())
app.use(express.json({ limit: '1mb' }))

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, service: 'wallet-mvp-server', time: new Date().toISOString() })
})

// ⬇️ 掛在 /issuer 前綴
app.use('/issuer', issuerRouter)
app.use('/verifier', verifierRouter)

// Debug：看 DB（保留）
app.get('/debug/db', async (_req, res) => {
  try {
    const [
      vcTxs, vcCreds, vpReqs, vpResults,
      vcTxCount, vcCredCount, vpReqCount, vpResCount
    ] = await Promise.all([
      prisma.vcTransaction.findMany({ orderBy: { id: 'desc' }, take: 10 }),
      prisma.vcCredential.findMany({ orderBy: { id: 'desc' }, take: 10 }),
      prisma.vpRequest.findMany({ orderBy: { id: 'desc' }, take: 10 }),
      prisma.vpResult.findMany({ orderBy: { id: 'desc' }, take: 10 }),
      prisma.vcTransaction.count(),
      prisma.vcCredential.count(),
      prisma.vpRequest.count(),
      prisma.vpResult.count(),
    ])
    res.json({
      summary: {
        vc_transactions: vcTxCount,
        vc_credentials: vcCredCount,
        vp_requests: vpReqCount,
        vp_results: vpResCount,
      },
      latest: {
        vc_transactions: vcTxs,
        vc_credentials: vcCreds,
        vp_requests: vpReqs,
        vp_results: vpResults,
      }
    })
  } catch (e: any) {
    res.status(500).json({ error: true, message: e.message })
  }
})

app.use((_req, res) => res.status(404).json({ error: 'Not Found' }))

const port = Number(process.env.PORT || 8001)
app.listen(port, () => {
  logger.info(`Server listening on http://localhost:${port}`)
})
