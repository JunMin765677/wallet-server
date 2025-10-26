import axios from 'axios'
import pino from 'pino'

const logger = pino({ level: process.env.NODE_ENV === 'production' ? 'info' : 'debug' })

const base = (process.env.WALLET_API_BASE || '').replace(/\/$/, '')
const key  = process.env.WALLET_API_KEY || ''
const timeout = Number(process.env.WALLET_TIMEOUT_MS || 20000)

const authHeaderName = process.env.WALLET_AUTH_HEADER || 'Access-Token' // 預設 Access-Token
const authScheme = (process.env.WALLET_AUTH_SCHEME || '').trim()        // 留空就不加前綴

if (!base) logger.warn('WALLET_API_BASE is empty')
if (!key)  logger.warn('WALLET_API_KEY is empty (will cause 401)')
logger.info({ base, authHeaderName, authScheme, keyLen: key.length }, 'Wallet API client configured')

const headers: Record<string,string> = {
  Accept: 'application/json',
  'Content-Type': 'application/json',
}
headers[authHeaderName] = authScheme ? `${authScheme} ${key}` : key

export const walletApi = axios.create({
  baseURL: base,
  timeout,
  headers,
})

export async function getCredentialByTx(transactionId: string) {
  const { data } = await walletApi.get(`/api/credential/nonce/${encodeURIComponent(transactionId)}`)
  return data
}

// 有個資：產生 VC QR
export async function createQrWithData(payload: {
  vcUid: string
  issuanceDate: string // YYYYMMDD
  expiredDate: string  // YYYYMMDD
  fields: Array<{ ename: string; content: string }>
}) {
  const { data } = await walletApi.post('/api/qrcode/data', payload)
  // 期待回應：{ transactionId, qrCode, deepLink }
  return data
}

export async function revokeCredential(cid: string) {
  // 依你提供的文件：/api/credential/{cid}/{action} 並用 action=revocation
  // 有些環境也支援 PUT /api/credential/{cid}/revocation
  // 以下採用 /{cid}/revocation（若你的沙盒是 /{cid}/{action}，把路徑改掉即可）
  const { data } = await walletApi.put(`/api/credential/${encodeURIComponent(cid)}/revocation`)
  // 預期：{ "credentialStatus": "REVOKED" }
  return data
}