// src/lib/jwt.ts

// Base64URL → UTF-8
function b64urlDecode(input: string): string {
  const pad = (s: string) => s + '==='.slice((s.length + 3) % 4)
  const base64 = pad(input).replace(/-/g, '+').replace(/_/g, '/')
  return Buffer.from(base64, 'base64').toString('utf-8')
}

export function decodeJwtPayload<T = unknown>(jwt: string): T {
  const parts = jwt.split('.')
  // parts[1] 可能不存在 → 先防呆
  if (parts.length < 2 || !parts[1]) {
    throw new Error('Invalid JWT: missing payload segment')
  }
  const payloadJson = b64urlDecode(parts[1]) // 這裡已保證是 string
  return JSON.parse(payloadJson) as T
}

// 從 jti URL 取 CID：".../api/credential/<CID>"
export function extractCidFromJti(jti?: string | null): string | null {
  if (!jti) return null
  const m = jti.match(/\/credential\/([A-Za-z0-9\-]+)$/)
  return m?.[1] ?? null // m 可能為 null，m[1] 也可能是 undefined
}
