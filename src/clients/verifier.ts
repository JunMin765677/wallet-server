import axios from 'axios'
import pino from 'pino'

const logger = pino({ level: process.env.NODE_ENV === 'production' ? 'info' : 'debug' })

const base = (process.env.VERIFIER_API_BASE || '').replace(/\/$/, '')
const key  = process.env.VERIFIER_API_KEY || ''
const timeout = Number(process.env.WALLET_TIMEOUT_MS || 20000)

const authHeaderName = process.env.VERIFIER_AUTH_HEADER || 'Access-Token'
const authScheme = (process.env.VERIFIER_AUTH_SCHEME || '').trim()

if (!base) logger.warn('VERIFIER_API_BASE is empty')
if (!key)  logger.warn('VERIFIER_API_KEY is empty (will cause 401)')
logger.info({ base, authHeaderName, authScheme, keyLen: key.length }, 'Verifier API client configured')

const headers: Record<string,string> = {
  Accept: 'application/json',
  'Content-Type': 'application/json',
}
headers[authHeaderName] = authScheme ? `${authScheme} ${key}` : key

export const verifierApi = axios.create({
  baseURL: base,
  timeout,
  headers,
})

// 產生驗證 QR：GET /api/oidvp/qrcode?ref&transactionId
export async function createVerifierQrCode(ref: string, transactionId: string) {
  const { data } = await verifierApi.get('/api/oidvp/qrcode', { params: { ref, transactionId } })
  // 回: { transactionId, qrcodeImage, authUri }
  return data
}

// 查結果：POST /api/oidvp/result  body: { transactionId }
export async function fetchVerifierResult(transactionId: string) {
  const { data, status } = await verifierApi.post('/api/oidvp/result', { transactionId })
  return { data, status }
}
