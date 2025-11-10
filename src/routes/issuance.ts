// src/routes/issuance.ts
import { Router } from 'express';
import { prisma } from '../index'; // PrismaClient instance exported from src/index.ts
import { IssuanceStatus, IssuanceLogStatus } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import axios from 'axios';
import { decode as jwtDecode } from 'jsonwebtoken';

// ⭐️ [新增] ⭐️ 用於隨機生成 Benefit Level 的輔助函式
const benefitLevelMap: Record<number, string[]> = {
  1: ['第一款', '第二款', '第三款'],
  2: ['輕', '中', '重', '極重'],
  3: ['無分級'],
  4: ['1_5倍以下', '1_5倍至2_5倍'], // (已移除 ".")
  5: ['無分級'],
  6: ['低風險', '中風險', '高風險'],
  7: ['無分級'],
  8: ['無分級'], // (新規則)
  9: ['無分級'], // (新規則)
  10: ['輕度', '中度以上'], // (新規則)
};

/**
 * 從陣列中隨機取得一個項目
 */
function getRandomItem<T>(items: T[]): T | undefined {
  if (!items || items.length === 0) return undefined;
  return items[Math.floor(Math.random() * items.length)];
}

/**
 * 根據 Template ID 生成 Benefit Level
 */
function generateBenefitLevel(templateId: number): string {
  const levels = benefitLevelMap[templateId];
  // (使用 "NA" 作為後備，以避免 Sandbox "N/A" 錯誤)
  return getRandomItem(levels) || 'NA';
}

const router = Router();

/**
 * [POST] /api/issuance/start-simulation
 * 對應 Pipeline 步驟 4, 5, 6, 7
 * 1) 接收「開始模擬」請求
 * 2) 隨機挑一位尚未擁有已「issued」VC 的 Person
 * 3) 將 personId 存入 server-side session（BigInt -> string）
 * 4) 回傳該 Person「有資格但尚未領取」的模板清單
 */
// [POST] /api/issuance/start-simulation
// (已整合 session.save() 修正 和 prisma.select 修正)
router.post('/start-simulation', async (req, res) => {
  // ⭐️ Log 1: 檢查 session 初始狀態
  console.log('[start-simulation] 請求開始。目前的 session:', JSON.stringify(req.session));

  try {
    // --- Step 5: 模擬身份配發 ---

    // A. 找出所有「已 issued」過的 personId
    const issuedPersonRecords = await prisma.issuedVC.findMany({
      select: { personId: true },
      distinct: ['personId'],
      where: { status: 'issued' as any }, // 使用 enum 時可改成 IssuanceStatus.issued
    });
    const issuedPersonIds = issuedPersonRecords.map(r => r.personId);

    // B. 找出候選人
    const candidates = await prisma.person.findMany({
      where: { id: { notIn: issuedPersonIds } },
      select: { id: true, name: true }, // 精簡傳輸
    });

    if (candidates.length === 0) {
      // ⭐️ Log 2: 檢查是否因為找不到人而提早 return
      console.log('[start-simulation] 錯誤：找不到可用的模擬使用者。回傳 404。');
      return res.status(404).json({
        message: '模擬失敗：目前沒有尚未領取過憑證的模擬使用者。',
      });
    }

    // C. 隨機選取
    const selected = candidates[Math.floor(Math.random() * candidates.length)];
    const personId = selected.id;

    // D. 將 personId 存入 session
    req.session.personId = personId.toString();

    // ⭐️ Log 3: 確認 personId 已被寫入 req.session 物件
    console.log(`[start-simulation] 已將 personId (${req.session.personId}) 存入 session 物件。`);
    
    // ⭐️⭐️⭐️ 關鍵修正：手動保存 Session ⭐️⭐️⭐️
    await new Promise<void>((resolve, reject) => {
      req.session.save((err) => {
        if (err) {
          console.error('[start-simulation] ！！ Session 儲存失敗 ！！', err);
          reject(new Error('Session save error'));
        } else {
          console.log('[start-simulation] Session 已成功儲存 (saved)。');
          resolve();
        }
      });
    });

    // --- Step 6: 業務邏輯判斷（有資格 & 尚未領取） ---

    // 1) 查詢「有資格」的 templateId
    const eligibilities = await prisma.personEligibility.findMany({
      where: { personId },
      select: { templateId: true },
    });
    const eligibleTemplateIds = eligibilities.map(e => e.templateId);

    // 2) 查詢「已 issued」的 templateId（針對此人）
    const alreadyIssued = await prisma.issuedVC.findMany({
      where: { personId, status: 'issued' as any },
      select: { templateId: true },
    });
    const alreadyIssuedTemplateIds = new Set(alreadyIssued.map(v => v.templateId));

    // 3) 有資格但尚未領取
    const availableTemplateIds = eligibleTemplateIds.filter(
      tid => !alreadyIssuedTemplateIds.has(tid),
    );

    // 4) 取模板資訊 (⭐️⭐️⭐️ 修正：還原 select 欄位 ⭐️⭐️⭐️)
    const availableTemplates = availableTemplateIds.length
      ? await prisma.vCTemplate.findMany({
          where: { id: { in: availableTemplateIds } },
          // 這裡是你原本正確的 select 內容
          select: {
            id: true, 
            templateName: true,
            vcUid: true,
            description: true,
            cardImageUrl: true,
            createdAt: true,
          },
        })
      : [];

    // --- Step 7: 回傳結果 ---
    // ⭐️ Log 4: 確認回傳 200
    console.log('[start-simulation] 邏輯全部完成，回傳 200 OK。');
    return res.status(200).json({
      person: {
        id: personId.toString(), // 僅 person.id 需要轉字串（schema 為 BigInt）
        name: selected.name,
      },
      availableTemplates, // template.id 是 Int，直接輸出即可
    });

  } catch (err) {
    console.error('[Issuer BE] /api/issuance/start-simulation 發生嚴重錯誤:', err);
    // ⭐️ Log 5: 檢查 try-catch 錯誤
    if (err instanceof Error && err.message === 'Session save error') {
      return res.status(500).json({ message: 'Session 儲存時發生錯誤' });
    }
    // 檢查是否為 Prisma 錯誤
    if (err instanceof Error && err.name === 'PrismaClientValidationError') {
      return res.status(500).json({ message: '資料庫查詢欄位錯誤 (Prisma Validation Error)' });
    }
    return res.status(500).json({ message: '伺服器內部錯誤' });
  }
});

/**
 * @route   POST /api/issuance/request-credential
 * @desc    (Step 9-13) 使用者選擇模板後，請求 VC 簽發 (更新版)
 * @body    { templateId: number }
 */
router.post('/request-credential', async (req, res) => {
  try {

    console.log('[request-credential] 請求開始。');
    console.log('[request-credential] 收到的 headers.cookie:', req.headers.cookie);
    console.log('[request-credential] 收到的 session 物件:', JSON.stringify(req.session));
    
    // --- Step 9: 取得 Session 和 Request Body ---
    const { templateId } = req.body;
    const personIdStr = req.session.personId;

    if (!personIdStr) {
      return res.status(401).json({ message: '您尚未開始模擬身份驗證，請重新操作' });
    }
    if (!templateId || typeof templateId !== 'number') {
      return res.status(400).json({ message: '未提供有效的 templateId (必須是數字)' });
    }

    const personId = BigInt(personIdStr);
    const systemUuid = uuidv4().replace(/-/g, '_');

    // --- 準備 API 呼叫的環境變數 ---
    const apiBase = process.env.WALLET_API_BASE;
    const apiKey = process.env.WALLET_API_KEY;

    if (!apiBase || !apiKey) {
      console.error('環境變數 WALLET_API_BASE 或 WALLET_API_KEY 未設定');
      return res.status(500).json({ message: '伺服器設定錯誤，無法呼叫簽發 API' });
    }

    // --- Step 10, 11, 12: 執行資料庫交易與 API 呼叫 ---
    const transactionResult = await prisma.$transaction(async (tx) => {
      
      // --- 10a: 取得 Person 和 Template 資料 ---
      const person = await tx.person.findUnique({
        where: { id: personId },
        select: { 
          name: true, 
          personalId: true,
          emergencyContactName: true,
          emergencyContactRelationship: true,
          emergencyContactPhone: true,
          reviewingAuthority: true,
          reviewerName: true,
          reviewerPhone: true,
        },
      });
      const template = await tx.vCTemplate.findUnique({
        where: { id: templateId },
        select: { vcUid: true },
      });

      if (!person) throw new Error('Person not found');
      if (!template) throw new Error('Template not found');
      if (!template.vcUid) throw new Error('Template vcUid is missing');

      // --- 10b: 產生 Benefit Level 並準備 issued_data ---
      // (將調用更新後的 generateBenefitLevel 函式)
      const benefitLevel = generateBenefitLevel(templateId);

      const issued_data = {
        name: person.name,
        personalId: person.personalId,
        system_uuid: systemUuid,
        benefitLevel: benefitLevel,
        emergencyContactName: person.emergencyContactName ?? '',
        emergencyContactRelationship: person.emergencyContactRelationship ?? '',
        emergencyContactPhone: person.emergencyContactPhone ?? '',
        reviewingAuthority: person.reviewingAuthority ?? '',
        reviewerName: person.reviewerName ?? '',
        // (主動過濾 reviewerPhone 中的 '-' 字元)
        reviewerPhone: (person.reviewerPhone ?? '').replace(/-/g, ''),
      };

      // --- 10c: 建立 IssuedVCs 紀錄 ---
      const newIssuedVC = await tx.issuedVC.create({
        data: {
          systemUuid: systemUuid,
          personId: personId,
          templateId: templateId,
          status: IssuanceStatus.issuing,
          issuedData: issued_data, 
          benefitLevel: benefitLevel, 
        },
      });

      // --- 11: 呼叫 Sandbox API ---
      const today = new Date();
      const issuanceDate = [
        today.getFullYear(),
        String(today.getMonth() + 1).padStart(2, '0'),
        String(today.getDate()).padStart(2, '0'),
      ].join('');
      
      const apiFields = Object.entries(issued_data).map(([key, value]) => ({
        ename: key,
        content: String(value ?? ''),
      }));

      const apiPayload = {
        vcUid: template.vcUid,
        issuanceDate: issuanceDate,
        expiredDate: "20251231",
        fields: apiFields,
      };

      const apiResponse = await axios.post(
        `${apiBase}/api/qrcode/data`,
        apiPayload,
        {
          headers: {
            'Access-Token': apiKey,
            'Content-Type': 'application/json',
            'accept': 'application/json',
          },
        }
      );

      const { transactionId, qrCode, deepLink } = apiResponse.data;

      if (!transactionId || !qrCode || !deepLink) {
        throw new Error('Sandbox API 回傳資料不完整');
      }

      // --- 12: 記錄 IssuanceLogs ---
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000); 
      await tx.issuanceLog.create({
        data: { transactionId, status: IssuanceLogStatus.initiated, expiresAt, issuedVcId: newIssuedVC.id },
      });

      return { qrCode, deepLink, transactionId };
    });

    // --- Step 13: 回傳結果給 FE ---
    return res.status(200).json(transactionResult);

  } catch (err) {
    // ... (錯誤處理邏輯不變) ...
    console.error('[Issuer BE] /api/issuance/request-credential error:', err);
    if (err instanceof Error) {
      if (err.message === 'Person not found') {
        return res.status(404).json({ message: '找不到對應的使用者資料' });
      }
      if (err.message === 'Template not found') {
        return res.status(404).json({ message: '找不到對應的 VC 模板' });
      }
      if (err.message === 'Template vcUid is missing') {
        return res.status(400).json({ message: 'VC 模板設定不完整 (缺少 vcUid)' });
      }
    }
    if (axios.isAxiosError(err)) {
      console.error('Sandbox API Error:', err.response?.data || err.message);
      return res.status(502).json({ 
        message: '呼叫 Sandbox API 失敗', 
        error: err.response?.data 
      });
    }
    return res.status(500).json({ message: '伺服器內部錯誤' });
  }
});


/**
 * @route   GET /api/issuance/status/:transactionId
 * @desc    (Step 15-18) FE 輪詢此 API 檢查 VC 領取狀態 (更新版)
 * @param   {string} transactionId - 要查詢的交易 ID
 */
router.get('/status/:transactionId', async (req, res) => {
  // 1. 驗證 Session (安全性)
  const personIdStr = req.session.personId;
  if (!personIdStr) {
    return res.status(401).json({ message: 'Session 遺失，請重新操作' });
  }
  const personId = BigInt(personIdStr);

  // ⭐️ [變更點] ⭐️ 從 URL 取得 transactionId
  const { transactionId } = req.params;
  if (!transactionId) {
    return res.status(400).json({ message: '未提供 transactionId' });
  }

  try {
    // 2. ⭐️ [變更點] ⭐️ 精確查找 Log，並驗證 personId 確保安全
    const activeLog = await prisma.issuanceLog.findUnique({
      where: {
        transactionId: transactionId,
        // 確保這個 Log 屬於當前 Session 的 personId
        issuedVC: {
          personId: personId,
        },
      },
      include: {
        issuedVC: true,
      },
    });

    // 3. 檢查 Log 是否存在
    if (!activeLog) {
      return res.status(404).json({ message: '找不到此簽發流程，或您無權查詢' });
    }

    // 4. 檢查是否已是「最終狀態」
    if (activeLog.status === IssuanceLogStatus.user_claimed) {
      return res.status(200).json({ status: 'issued', message: '已領取成功' });
    }
    if (activeLog.status === IssuanceLogStatus.expired) {
      return res.status(200).json({ status: 'expired', message: '簽發流程已過期' });
    }
    
    // (到這裡，狀態必定是 'initiated')

    // 5. (Step 18) 檢查是否已過期
    if (activeLog.expiresAt && new Date() > activeLog.expiresAt) {
      await prisma.$transaction([
        prisma.issuanceLog.update({
          where: { id: activeLog.id },
          data: { status: IssuanceLogStatus.expired },
        }),
        prisma.issuedVC.update({
          where: { id: activeLog.issuedVC.id },
          data: { status: IssuanceStatus.expired },
        }),
      ]);
      return res.status(200).json({ status: 'expired', message: '簽發流程已過期' });
    }

    // 6. (Step 15) 呼叫 Sandbox API 檢查憑證狀態
    const apiBase = process.env.WALLET_API_BASE;
    const apiKey = process.env.WALLET_API_KEY;

    if (!apiBase || !apiKey) {
      return res.status(500).json({ message: '伺服器環境變數設定不完整' });
    }

    // ⭐️ [變更點] ⭐️ 使用 URL 傳入的 transactionId 查詢
    const apiResponse = await axios.get(
      `${apiBase}/api/credential/nonce/${transactionId}`,
      {
        headers: {
          'Access-Token': apiKey,
          'accept': '*/*',
        },
      }
    );

    // 7. (Step 16-17) 輪詢成功！使用者已領取
    const credentialJWT = apiResponse.data.credential;
    if (!credentialJWT) {
      throw new Error('Sandbox API 回傳 200 OK 但缺少 credential');
    }

    const decoded = jwtDecode(credentialJWT);
    if (!decoded || typeof decoded !== 'object' || !decoded.jti) {
      throw new Error('解析 JWT 失敗或缺少 jti');
    }

    const jti = decoded.jti as string;
    const cid = jti.split('credential/').pop();

    if (!cid) {
      throw new Error('無法從 jti 解析出 CID');
    }

    // 更新資料庫
    await prisma.$transaction([
      prisma.issuanceLog.update({
        where: { id: activeLog.id },
        data: { status: IssuanceLogStatus.user_claimed },
      }),
      prisma.issuedVC.update({
        where: { id: activeLog.issuedVC.id },
        data: {
          status: IssuanceStatus.issued,
          cid: cid,
          issuedAt: new Date(),
        },
      }),
    ]);

    return res.status(200).json({ status: 'issued', message: '領取成功' });

  } catch (err) {
    // 8. (Step 15 繼續) 處理 Sandbox API 的錯誤
    if (axios.isAxiosError(err)) {
      if (err.response?.data?.code === '61010') {
        return res.status(200).json({ status: 'initiated', message: '使用者尚未領取' });
      }
      console.error('Sandbox API Error:', err.response?.data || err.message);
      return res.status(502).json({ 
        message: 'Sandbox API 查詢失敗', 
        error: err.response?.data 
      });
    }

    // 9. 其他內部錯誤
    console.error(`[Issuer BE] /api/issuance/status/${transactionId} error:`, err);
    return res.status(500).json({ 
      message: '伺服器內部錯誤', 
      error: err instanceof Error ? err.message : String(err) 
    });
  }
});


export default router;
