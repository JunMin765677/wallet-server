import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../db'
import { createQrWithData, getCredentialByTx, revokeCredential } from '../clients/wallet'
import { decodeJwtPayload, extractCidFromJti } from '../lib/jwt'

const r = Router()

/**
 * GET YYYYMMDD string for today in local timezone
 */
function getTodayYyyyMmDd() {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const day = String(today.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}


/** POST /issuer/qrcode/data
 * body: {
 * vcUid: string,
 * name: string
 * }
 */
r.post('/qrcode/data', async (req, res) => {
  try {
    const body = z.object({
      vcUid: z.string().min(1),
      name: z.string().min(1)
    }).parse(req.body)

    const issuanceDate = getTodayYyyyMmDd();
    const expiredDate = '20251031';
    const companyName = '魔法部';

    // 組成平台預期 payload
    const payload = {
      vcUid: body.vcUid,
      issuanceDate,
      expiredDate,
      fields: [
        { ename: 'name',        content: body.name },
        { ename: 'expiredDate', content: expiredDate },
        { ename: 'company',     content: companyName },
      ],
    }

    const apiOut = await createQrWithData(payload)

    const txId: string | undefined = apiOut?.transactionId
    if (!txId) return res.status(502).json({ error: true, message: 'transactionId missing from wallet API' })

    // 寫 DB（mode=DATA）
    await prisma.vcTransaction.create({
      data: {
        transactionId: txId,
        vcUid: body.vcUid,
        mode: 'DATA',
        requestPayload: payload,
        responsePayload: apiOut,
        status: 'CREATED',
      }
    })

    return res.status(201).json({
      transactionId: apiOut.transactionId,
      qrCode: apiOut.qrCode,
      deepLink: apiOut.deepLink,
    })
  } catch (e: any) {
    if (e.response) {
      return res.status(e.response.status || 500).json(e.response.data || { error: true, message: 'wallet api error' })
    }
    return res.status(400).json({ error: true, message: e.message })
  }
})

/** GET /issuer/credential/:transactionId
 * 回：{ transactionId, cid, issuedAt, rawCredential }
 * 並寫入 vc_credentials（若已存在則直接回資料）
 */
r.get('/credential/:transactionId', async (req, res) => {
  const params = z.object({ transactionId: z.string().min(1) }).safeParse(req.params)
  if (!params.success) return res.status(400).json({ error: true, message: 'transactionId 無效' })
  const { transactionId } = params.data

  try {
    // 已存在就直接回（idempotent）
    const existed = await prisma.vcCredential.findUnique({ where: { transactionId } })
    if (existed) {
      return res.json({
        transactionId,
        cid: existed.cid,
        issuedAt: existed.issuedAt,
      })
    }

    // 向沙盒取 credential（若使用者尚未領取，沙盒通常回 400）
    const data = await getCredentialByTx(transactionId)
    const jwt = (data?.credential as string | undefined) || ''
    if (!jwt) return res.status(404).json({ error: true, message: 'credential 尚未就緒' })

    // 解析 payload 取得 jti → CID
    const payload = decodeJwtPayload<any>(jwt)
    const cid = extractCidFromJti(String(payload?.jti || '')) || ''
    if (!cid) return res.status(502).json({ error: true, message: '無法從 jti 抽出 CID' })

    const saved = await prisma.vcCredential.create({
      data: { cid, transactionId, rawJwt: jwt, status: 'ISSUED' }
    })

    return res.json({
      transactionId,
      cid: saved.cid,
      issuedAt: saved.issuedAt,
    })
  } catch (e: any) {
    if (e?.response) {
      // 轉發沙盒錯誤（例如 400: 尚未被掃描）
      return res.status(e.response.status || 500).json(e.response.data || { error: true, message: 'wallet api error' })
    }
    return res.status(400).json({ error: true, message: e?.message || 'unknown error' })
  }
})
// 撤銷憑證
r.put('/credential/:cid/revocation', async (req, res) => {
  const params = z.object({ cid: z.string().min(1) }).safeParse(req.params)
  if (!params.success) return res.status(400).json({ error: true, message: 'cid 無效' })
  const { cid } = params.data

  try {
    const out = await revokeCredential(cid)
    // 預期 out = { credentialStatus: "REVOKED" }，也容忍大小寫差異
    const statusStr = String(out?.credentialStatus || '').toUpperCase()
    if (statusStr !== 'REVOKED') {
      // 沙盒非預期回應也記錄並提示
      return res.status(502).json({ error: true, message: 'wallet api 未回 REVOKED', payload: out })
    }

    // DB 更新（若不存在就不報錯；也可先查，有就更新）
    const updated = await prisma.vcCredential.updateMany({
      where: { cid },
      data: { status: 'REVOKED', revokedAt: new Date() }
    })

    return res.json({
      cid,
      credentialStatus: 'REVOKED',
      updatedRows: updated.count, // 若為 0 代表你尚未把該憑證寫入本地；僅供提示
    })
  } catch (e: any) {
    if (e?.response) {
      return res.status(e.response.status || 500).json(e.response.data || { error: true, message: 'wallet api error' })
    }
    return res.status(400).json({ error: true, message: e?.message || 'unknown error' })
  }
})

/** GET /issuer/credentials
 * [FINAL VERSION] 透過 DB 關聯取得所有 VC 列表及驗證資訊
 */
r.get('/credentials', async (req, res) => {
  try {
    const credentials = await prisma.vcCredential.findMany({
      include: {
        transaction: true, // 取得 vcUid, name 等資訊
        verifications: {   // 直接 include 新建立的關聯
          select: {
            receivedAt: true // 只需要驗證時間
          },
          orderBy: {
            receivedAt: 'desc' // 排序以便取最新
          }
        },
      },
      orderBy: {
        issuedAt: 'desc',
      },
    });

    const results = credentials.map(cred => {
      const verificationCount = cred.verifications.length;
      // [FIXED] 使用 Optional Chaining (?.) 確保型別安全
      const lastVerifiedAt = cred.verifications[0]?.receivedAt ?? null;
      
      // 從 transaction.requestPayload 解析 name
      const payload = cred.transaction.requestPayload as any;
      const nameField = Array.isArray(payload?.fields)
        ? payload.fields.find((f: any) => f.ename === 'name')
        : null;
      const name = nameField?.content || 'N/A';

      return {
        cid: cred.cid,
        status: cred.status,
        issuedAt: cred.issuedAt,
        revokedAt: cred.revokedAt,
        name,
        vcUid: cred.transaction.vcUid,
        transactionId: cred.transactionId,
        verificationCount,
        lastVerifiedAt,
      };
    });
    
    return res.json(results);
  } catch (e: any) {
    console.error('Failed to fetch credentials:', e);
    return res.status(500).json({ error: true, message: '讀取憑證列表時發生錯誤' });
  }
});


export default r

