import { Router } from 'express'
import { z } from 'zod'
import { v4 as uuidv4 } from 'uuid'
import { prisma } from '../db'
import { createVerifierQrCode, fetchVerifierResult } from '../clients/verifier'

const r = Router()

/** POST /verifier/qrcode
 * body: { ref }
 */
r.post('/qrcode', async (req, res) => {
  try {
    const body = z.object({ ref: z.string().min(1) }).parse(req.body)
    const txId = uuidv4()

    const apiOut = await createVerifierQrCode(body.ref, txId)
    if (!apiOut?.transactionId || !apiOut?.qrcodeImage) {
      return res.status(502).json({ error: true, message: 'verifier api 回應不完整', payload: apiOut })
    }

    await prisma.vpRequest.create({
      data: {
        transactionId: apiOut.transactionId,
        ref: body.ref,
        status: 'CREATED',
      }
    })

    return res.status(201).json({
      transactionId: apiOut.transactionId,
      qrcodeImage: apiOut.qrcodeImage,
      authUri: apiOut.authUri,
    })
  } catch (e: any) {
    if (e?.response) {
      return res.status(e.response.status || 500).json(e.response.data || { error: true, message: 'verifier api error' })
    }
    return res.status(400).json({ error: true, message: e?.message || 'unknown error' })
  }
})

/** POST /verifier/result
 * [REVISED] 收到驗證結果，解析 cid 並存入新的 DB 關聯欄位
 */
const VERIFY_TIMEOUT_MS = 2 * 60 * 1000
r.post('/result', async (req, res) => {
  try {
    const body = z.object({ transactionId: z.string().min(1) }).parse(req.body)

    const reqRow = await prisma.vpRequest.findUnique({ where: { transactionId: body.transactionId } })
    if (reqRow && Date.now() - new Date(reqRow.createdAt).getTime() > VERIFY_TIMEOUT_MS) {
      await prisma.vpRequest.update({ where: { transactionId: body.transactionId }, data: { status: 'TIMEOUT' } })
      return res.status(408).json({ message: '驗證逾時，請重新產生 QR' })
    }

    const { data, status } = await fetchVerifierResult(body.transactionId)

    if (status === 200) {
      const verifyResult: boolean = !!data?.verifyResult
      const claims = Array.isArray(data?.data) ? data.data : []

      // --- [NEW LOGIC] 從 claims 中解析出 cid ---
      const extractCidFromJti = (jti?: string | null): string | null => {
        if (!jti) return null
        const m = jti.match(/\/credential\/([A-Za-z0-9\-]+)$/)
        return m?.[1] ?? null
      }
      const findJtiRecursively = (obj: any): string | null => {
        if (!obj || typeof obj !== 'object') return null
        if ('jti' in obj && typeof obj.jti === 'string') return obj.jti
        for (const key in obj) {
          if (obj.hasOwnProperty(key)) {
            const result = findJtiRecursively(obj[key]);
            if (result) return result
          }
        }
        return null
      }
      let verifiedCid: string | null = null;
      for (const claim of claims) {
          const jti = findJtiRecursively(claim);
          if (jti) {
              verifiedCid = extractCidFromJti(jti);
              if (verifiedCid) break; // 找到就跳出
          }
      }
      // --- [END NEW LOGIC] ---

      await prisma.vpResult.upsert({
        where: { transactionId: body.transactionId },
        update: { 
          verifyResult, 
          claims, 
          raw: data, 
          receivedAt: new Date(),
          vcCredentialCid: verifiedCid, // 儲存關聯
        },
        create: { 
          transactionId: body.transactionId, 
          verifyResult, 
          claims, 
          raw: data,
          vcCredentialCid: verifiedCid, // 儲存關聯
        },
      })
      await prisma.vpRequest.updateMany({
        where: { transactionId: body.transactionId },
        data: { status: 'COMPLETED' }
      })

      return res.json({
        verifyResult,
        claims,
        transactionId: data?.transactionId ?? body.transactionId,
        resultDescription: data?.resultDescription ?? 'success',
      })
    }

    return res.status(202).json({ message: '尚未完成，請稍後再試' })
  } catch (e: any) {
    const st = e?.response?.status
    if (st === 400) {
      return res.status(202).json({ message: '尚未完成，請稍後再試' })
    }
    if (e?.response) {
      return res.status(st || 500).json(e.response.data || { error: true, message: 'verifier api error' })
    }
    return res.status(400).json({ error: true, message: e?.message || 'unknown error' })
  }
})

r.post('/result/raw', async (req, res) => {
  try {
    const body = z.object({ transactionId: z.string().min(1) }).parse(req.body)
    const { data, status } = await fetchVerifierResult(body.transactionId)
    res.status(status).json({ status, data })
  } catch (e:any) {
    res.status(e?.response?.status || 500).json(e?.response?.data || { error: true, message: e.message })
  }
})

r.get('/result/:transactionId', async (req, res) => {
  const { transactionId } = req.params
  const found = await prisma.vpResult.findUnique({ where: { transactionId } })
  if (!found) return res.status(404).json({ error: true, message: 'not found' })
  res.json(found)
})


r.get('/history', async (req, res) => {
  try {
    const requests = await prisma.vpRequest.findMany({
      include: {
        result: true, // 包含關聯的驗證結果
      },
      orderBy: {
        createdAt: 'desc',
      },
    });
    res.json(requests);
  } catch (e: any) {
    console.error('Failed to fetch verification history:', e);
    res.status(500).json({ error: true, message: '讀取驗證紀錄時發生錯誤' });
  }
});

export default r

