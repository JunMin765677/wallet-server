// src/routes/verification.ts
import { Router } from 'express';
import { prisma } from '../index';
import { VerificationStatus, IssuanceStatus, BatchVerificationStatus } from '@prisma/client';
import type { 
  Prisma, 
  VerificationLog 
} from '@prisma/client';
import * as qrcode from 'qrcode';
import { v4 as uuidv4 } from 'uuid';
import axios from 'axios';

type Claim = {
  ename: string;
  cname: string;
  value: string;
};

type CredentialData = {
  credentialType: string;
  claims: Claim[];
};

type VpResultResponse = {
  data: CredentialData[];
  verifyResult: boolean;
  resultDescription: string;
  transactionId: string;
};



// (BE-3.A) 共用的輔助函式 (Step 25 邏輯)
// -------------------------------------------------
/**
 * 根據 personId 抓取驗證成功時所需的回傳資料
 * (對應 Step 25 的 payload)
 */
async function getVerificationSuccessPayload(personId: bigint, rawSandboxData: any) {
  // 1. 取得 Person 詳細資料
  const personDetailsPromise = prisma.person.findUnique({
    where: { id: personId },
    select: {
      name: true,
      nationalId: true,
      emergencyContactName: true,
      emergencyContactRelationship: true,
      emergencyContactPhone: true,
      reviewingAuthority: true,
      reviewerName: true,
      reviewerPhone: true,
    }
  });

  // 2. 取得此人所有 "已簽發" 的 VCs
  const issuedVCsPromise = prisma.issuedVC.findMany({
    where: {
      personId: personId,
      status: IssuanceStatus.issued,
    },
    select: {
      benefitLevel: true, // 福利資格等級
      template: {
        select: {
          templateName: true, // 模板名稱
          cardImageUrl: true, // 卡面圖片
        }
      }
    }
  });

  const [personDetails, issuedVCs] = await Promise.all([
    personDetailsPromise,
    issuedVCsPromise
  ]);

  if (!personDetails) {
    // 雖然 Log 成功，但關聯的 Person 卻找不到了 (罕見)
    return null; 
  }

  // 3. 組合 'verifiedCredentials'
  const verifiedCredentials = issuedVCs.map(vc => ({
    templateName: vc.template.templateName,
    benefitLevel: vc.benefitLevel,
    cardImageUrl: vc.template.cardImageUrl,
  }));

  // 4. 組合最終 Payload
  const verificationPayload = {
    person: {
      name: personDetails.name,
      nationalId: personDetails.nationalId,
    },
    contact: {
      emergencyContactName: personDetails.emergencyContactName,
      emergencyContactRelationship: personDetails.emergencyContactRelationship,
      emergencyContactPhone: personDetails.emergencyContactPhone,
    },
    reviewer: {
      reviewingAuthority: personDetails.reviewingAuthority,
      reviewerName: personDetails.reviewerName,
      reviewerPhone: personDetails.reviewerPhone,
    },
    verifiedCredentials: verifiedCredentials,
    rawSandboxData: rawSandboxData, 
  };
  
  return verificationPayload;
}
// -------------------------------------------------
// (BE-3.C) 批次輪詢的 "內部" 輔助函式
// -------------------------------------------------
/**
 * 輪詢並更新 "單一" 批次 Log (不回傳任何值)
 * (此函式在 check-batch-status 中被呼叫)
 */
async function pollAndUpdateBatchLog(log: VerificationLog) {
  // 1. 檢查是否已過期 (Log 本身)
  if (log.expiresAt && new Date() > log.expiresAt) {
    await prisma.verificationLog.update({
      where: { id: log.id },
      data: { status: VerificationStatus.expired },
    });
    return; // 已處理
  }

  // 2. 呼叫 Sandbox API
  try {
    const apiBase = process.env.VERIFIER_API_BASE;
    const apiKey = process.env.VERIFIER_API_KEY;
    // (不檢查 env，假設在主函式已檢查)
    
    const apiResponse = await axios.post(
      `${apiBase}/api/oidvp/result`,
      { transactionId: log.transactionId },
      { headers: { 'Access-Token': apiKey, 'Content-Type': 'application/json', 'accept': '*/*' } }
    );

    // 3. (Step 20) Sandbox 成功回傳
    const { data, verifyResult, resultDescription } = apiResponse.data as VpResultResponse;
    const returnedData = apiResponse.data;

    // 4. (Step 21 - Case A) 驗證失敗
    if (verifyResult === false) {
      await prisma.verificationLog.update({
        where: { id: log.id },
        data: { status: VerificationStatus.failed, verifyResult: false, resultDescription: resultDescription || '驗證失敗', returnedData: returnedData },
      });
      return;
    }

    // 5. (Step 21 - Case B) 驗證成功，找出 personalId
    let foundPersonalIdString: string | null = null;
    if (data && Array.isArray(data) && data.length > 0 && data[0].claims && Array.isArray(data[0].claims)) {
      const claim = data[0].claims.find(c => c.ename === 'personalId');
      if (claim && claim.value) { foundPersonalIdString = claim.value; }
    }

    // 6. (Step 21 - Sub-Case B2) 找不到 personalId
    if (!foundPersonalIdString) {
      await prisma.verificationLog.update({
        where: { id: log.id },
        data: { status: VerificationStatus.error_missing_uuid, verifyResult: true, resultDescription: '驗證成功，但資料缺少 personalId', returnedData: returnedData },
      });
      return;
    }

    // 7. (Step 21 - Sub-Case B1) 完美成功
    // (我們必須在 $transaction 中執行此操作，以防 Person 查找失敗)
    await prisma.$transaction(async (tx) => {
      const person = await tx.person.findUnique({
        where: { personalId: foundPersonalIdString as string },
        select: { id: true }
      });

      if (!person) {
        await tx.verificationLog.update({
          where: { id: log.id },
          data: { status: VerificationStatus.error_missing_uuid, verifyResult: true, resultDescription: '驗證成功，但無法在資料庫中關聯使用者', returnedData: returnedData, verifiedPersonId: null },
        });
      } else {
        await tx.verificationLog.update({
          where: { id: log.id },
          data: { status: VerificationStatus.success, verifyResult: true, resultDescription: resultDescription || '驗證成功', returnedData: returnedData, verifiedPersonId: person.id },
        });
      }
    });

  } catch (err) {
    // 8. 處理 Sandbox API 的 "pending"
    if (axios.isAxiosError(err)) {
      if (err.response?.status === 400 && err.response?.data?.params) {
        try {
          const paramsData = JSON.parse(err.response.data.params);
          if (paramsData.code === 4002) {
            // 狀態為 'initiated'，是 "pending"，我們什麼都不做
            return; 
          }
        } catch (parseError) { /* ... */ }
      }
      // 其他 Sandbox 錯誤 (例如 500) -> 我們將此 Log 標記為 failed
      await prisma.verificationLog.update({
        where: { id: log.id },
        data: { status: VerificationStatus.failed, resultDescription: 'Sandbox 輪詢錯誤' },
      });
    } else {
      // 程式碼內部錯誤
      await prisma.verificationLog.update({
        where: { id: log.id },
        data: { status: VerificationStatus.failed, resultDescription: '內部輪詢錯誤' },
      });
    }
  }
}
// -------------------------------------------------


const router = Router();

/**
 * [POST] /api/verification/request-verification
 * 對應 Pipeline Part 2 的步驟 5~7 (BE-1)
 * (更新版：支援 "single" 和 "batch" 模式，並回傳 expiresAt)
 *
 * 輸入 (Body): { verificationMode: string, role: string, verifier: string, reason: string, notes?: string }
 * 輸出 (Success): { ..., expiresAt: string }
 */
router.post('/request-verification', async (req, res) => {
  try {
    // --- Step 5: 取得 Verifier FE 傳入的 metadata ---
    const { verificationMode, role, verifier, reason, notes } = req.body as {
      verificationMode: 'single' | 'batch';
      role: string;
      verifier: string;
      reason: string;
      notes?: string;
    };

    // --- 驗證輸入 ---
    if (!role || !verifier || !reason) {
      return res.status(400).json({ message: 'role (角色), verifier (單位), reason (目的) 均為必填' });
    }
    if (!['single', 'batch'].includes(verificationMode)) {
      return res.status(400).json({ message: '未提供有效的 verificationMode ("single" 或 "batch")' });
    }

    // --- Step 6: 流程分岔 ---
    
    // ===========================================
    // Case A: 單次驗證 (verificationMode: "single")
    // ===========================================
    if (verificationMode === 'single') {
      
      // --- (Step 14a) 準備呼叫 Sandbox API ---
      const apiBase = process.env.VERIFIER_API_BASE;
      const apiKey = process.env.VERIFIER_API_KEY;
      if (!apiBase || !apiKey) {
        console.error('VERIFIER_API 環境變數未設定');
        return res.status(500).json({ message: '伺服器設定錯誤 (VERIFIER_API)' });
      }

      const transactionId = uuidv4();
      const fixedRef = '00000000_template001';

      const apiResponse = await axios.get(
        `${apiBase}/api/oidvp/qrcode`,
        {
          params: { ref: fixedRef, transactionId: transactionId },
          headers: { 'Access-Token': apiKey, 'accept': '*/*' },
        }
      );

      // --- (Step 15a) 取得 Sandbox 回傳資料 ---
      const { qrcodeImage, authUri } = apiResponse.data;
      if (!qrcodeImage || !authUri) {
        throw new Error('Sandbox API 回傳資料不完整');
      }

      // --- (Step 16a) 預先寫入 VerificationLogs ---
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // +5 分鐘

      await prisma.verificationLog.create({
        data: {
          transactionId: transactionId,
          verifierInfo: role,
          verifierBranch: verifier,
          verificationReason: reason,
          notes: notes ?? null,
          status: VerificationStatus.initiated,
          expiresAt: expiresAt, // 存入 DB
          batchVerificationSessionId: null,
        },
      });

      // --- (Step 17a) 回傳給 Verifier FE ---
      return res.status(200).json({
        type: 'single',
        transactionId: transactionId,
        qrCode: qrcodeImage,
        deepLink: authUri,
        expiresAt: expiresAt.toISOString(), // [⭐️ 新增 ⭐️] 回傳 ISO 格式時間戳
      });
    }
    
    // ===========================================
    // Case B: 批次驗證 (verificationMode: "batch")
    // ===========================================
    else { // (verificationMode === 'batch')
      
      // --- (Step 14b) 建立批次工作階段 ---
      const appBaseUrl = process.env.APP_BASE_URL;
      if (!appBaseUrl) {
        console.error('環境變數 APP_BASE_URL 未設定');
        return res.status(500).json({ message: '伺服器設定錯誤 (APP_BASE_URL)' });
      }

      const expiresAt = new Date(Date.now() + 3 * 60 * 60 * 1000); // +3 小時

      const newSession = await prisma.batchVerificationSession.create({
        data: {
          verifierInfo: role,
          verifierBranch: verifier,
          verificationReason: reason,
          notes: notes ?? null,
          status: BatchVerificationStatus.active,
          expiresAt: expiresAt, // 存入 DB
        },
      });

      // --- (Step 17b) 產生我們自己的 QR code ---
      // (假設 BE-2 路由為 /api/verification/batch/:uuid)
      const batchUrl = `${appBaseUrl}/api/verification/batch/${newSession.uuid}`;
      
      // 將 URL 轉換為 Base64 圖片
      const qrCodeImage = await qrcode.toDataURL(batchUrl);

      // --- (Step 17b) 回傳給 Verifier FE ---
      return res.status(200).json({
        type: 'batch',
        batchSessionUuid: newSession.uuid,
        qrCode: qrCodeImage,
        expiresAt: expiresAt.toISOString(), // [⭐️ 新增 ⭐️] 回傳 ISO 格式時間戳
      });
    }

  } catch (err) {
    console.error('[Verifier BE] /request-verification error:', err);
    if (axios.isAxiosError(err)) {
      console.error('Sandbox Verifier API Error:', err.response?.data || err.message);
      return res.status(502).json({
        message: '呼叫 Sandbox 驗證 API 失敗', 
        error: err.response?.data 
      });
    }
    // 處理 qrcode 產生錯誤或其他錯誤
    return res.status(500).json({ 
      message: '伺服器內部錯誤',
      error: err instanceof Error ? err.message : String(err)
    });
  }
});

/**
 * [GET] /api/verification/batch/:uuid
 * 對應 Pipeline Part 2 的步驟 9 (BE-2)
 * (App 掃描 "批次 QR code" 後會請求此 API)
 *
 * @param {string} uuid - (來自 URL) 批次工作階段的 UUID
 * 輸出 (Success): 302 Redirect to Sandbox deepLink
 * 輸出 (Error): 404 Not Found, 500 Server Error
 */
router.get('/batch/:uuid', async (req, res) => {
  try {
    const { uuid } = req.params;
    if (!uuid) {
      // (App 掃描通常不會看到這個，但還是加上)
      return res.status(400).json({ message: '未提供批次工作階段 UUID' });
    }

    // --- Step 9 (BE-2): 查找並驗證 Batch Session ---
    const batchSession = await prisma.batchVerificationSession.findUnique({
      where: { uuid: uuid },
    });

    // 驗證 1: 是否存在
    if (!batchSession) {
      return res.status(404).json({ message: '找不到此批次驗證工作階段' });
    }

    // 驗證 2: 狀態是否 active
    if (batchSession.status !== BatchVerificationStatus.active) {
      return res.status(410).json({ message: '此批次驗證工作階段已結束' }); // 410 Gone
    }

    // 驗證 3: 是否已過期
    if (batchSession.expiresAt && new Date() > batchSession.expiresAt) {
      // (順便更新一下 DB 狀態)
      await prisma.batchVerificationSession.update({
        where: { id: batchSession.id },
        data: { status: BatchVerificationStatus.expired },
      });
      return res.status(410).json({ message: '此批次驗證工作階段已過期' }); // 410 Gone
    }
    
    // --- Step 9 (BE-2 / 14a): 呼叫 Sandbox API 取得 "一次性" 驗證 ---
    const apiBase = process.env.VERIFIER_API_BASE;
    const apiKey = process.env.VERIFIER_API_KEY;
    if (!apiBase || !apiKey) {
      console.error('VERIFIER_API 環境變數未設定 (in /batch/:uuid)');
      return res.status(500).json({ message: '伺服器設定錯誤 (VERIFIER_API)' });
    }

    const transactionId = uuidv4(); // 產生一個新的一次性 transactionId
    const fixedRef = '00000000_template001';

    const apiResponse = await axios.get(
      `${apiBase}/api/oidvp/qrcode`,
      {
        params: { ref: fixedRef, transactionId: transactionId },
        headers: { 'Access-Token': apiKey, 'accept': '*/*' },
      }
    );

    // --- (取得 Sandbox 回傳資料) ---
    // (我們主要需要 authUri，也就是 deepLink)
    const { authUri } = apiResponse.data;
    if (!authUri) {
      throw new Error('Sandbox API 回傳資料不完整 (缺少 authUri)');
    }

    // --- Step 9 (BE-2 / 16a): 建立 "一次性" VerificationLog ---
    // (將 BatchSession 的 metadata 複製過來)
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // +5 分鐘 (單次驗證的時效)

    await prisma.verificationLog.create({
      data: {
        transactionId: transactionId, // Sandbox 的一次性 ID
        // 從 BatchSession 複製 metadata
        verifierInfo: batchSession.verifierInfo,
        verifierBranch: batchSession.verifierBranch,
        verificationReason: batchSession.verificationReason,
        notes: batchSession.notes,
        // 設定狀態
        status: VerificationStatus.initiated,
        expiresAt: expiresAt,
        // [⭐️ 關鍵 ⭐️] 關聯回 Batch Session
        batchVerificationSessionId: batchSession.id, 
      },
    });

    // --- Step 9 (BE-2): 回傳 302 Redirect ---
    // (App 收到 302 就會自動導向 authUri)
    return res.redirect(302, authUri);

  } catch (err) {
    console.error(`[Verifier BE] /batch/${req.params.uuid} error:`, err);
    if (axios.isAxiosError(err)) {
      console.error('Sandbox Verifier API Error (in /batch):', err.response?.data || err.message);
      return res.status(502).json({
        message: '呼叫 Sandbox 驗證 API 失敗', 
        error: err.response?.data 
      });
    }
    return res.status(500).json({ 
      message: '伺服器內部錯誤',
      error: err instanceof Error ? err.message : String(err)
    });
  }
});



/**
 * [GET] /api/verification/check-status/:transactionId
 * (BE-3.B) API 1: 處理「單次驗證」的輪詢 (重構版)
 * (此版本已確認會在 success 時回傳完整的 verificationData)
 *
 * @param {string} transactionId - (來自 URL) 
 */
router.get('/check-status/:transactionId', async (req, res) => {
  const { transactionId } = req.params;
  if (!transactionId) {
    return res.status(400).json({ message: '未提供 transactionId' });
  }

  try {
    // 1. 檢查我方資料庫的紀錄
    const log = await prisma.verificationLog.findUnique({
      where: { transactionId: transactionId },
    });

    if (!log) {
      return res.status(404).json({ message: '找不到此驗證流程' });
    }

    // 2. 如果狀態不是 'initiated' (已完成)
    if (log.status !== VerificationStatus.initiated) {
      
      // (此區塊處理 "已完成" 的 Log)
      if (log.status === VerificationStatus.success && log.verifiedPersonId) {
        // [⭐️ 關鍵 ⭐️] 呼叫輔助函式抓取完整資料
        const verificationData = await getVerificationSuccessPayload(log.verifiedPersonId, log.returnedData);
        
        if (!verificationData) {
          return res.status(404).json({ status: log.status, message: "驗證成功，但關聯的使用者資料已不存在" });
        }

        return res.status(200).json({
          status: log.status,
          message: log.resultDescription,
          verificationData: verificationData, // (回傳完整資料)
        });
      }
      
      // (failed, expired, error_missing_uuid...)
      return res.status(200).json({
        status: log.status,
        message: log.resultDescription || '驗證流程已結束',
        data: log.returnedData, // (失敗時回傳原始 data)
      });
    }

    // 3. (Step 22) 檢查是否已過期
    if (log.expiresAt && new Date() > log.expiresAt) {
      const updatedLog = await prisma.verificationLog.update({
        where: { id: log.id }, data: { status: VerificationStatus.expired },
      });
      return res.status(200).json({ status: updatedLog.status, message: '驗證流程已過期' });
    }

    // 4. (Step 19) 呼叫 Sandbox API 輪詢
    const apiBase = process.env.VERIFIER_API_BASE;
    const apiKey = process.env.VERIFIER_API_KEY;
    if (!apiBase || !apiKey) { return res.status(500).json({ message: '伺服器設定錯誤 (VERIFIER_API)' }); }

    const apiResponse = await axios.post(
      `${apiBase}/api/oidvp/result`,
      { transactionId: transactionId }, 
      { headers: { 'Access-Token': apiKey, 'Content-Type': 'application/json', 'accept': '*/*' } }
    );

    // 5. (Step 20) Sandbox API 成功回傳
    const { data, verifyResult, resultDescription } = apiResponse.data as VpResultResponse;
    const returnedData = apiResponse.data; 

    // 6. (Step 21 - Case A) 驗證失敗
    if (verifyResult === false) {
      const updatedLog = await prisma.verificationLog.update({
        where: { id: log.id },
        data: { status: VerificationStatus.failed, verifyResult: false, resultDescription: resultDescription || '驗證失敗', returnedData: returnedData },
      });
      return res.status(200).json({ status: updatedLog.status, message: updatedLog.resultDescription });
    }

    // 7. (Step 21 - Case B) 驗證成功，找出 personalId
    let foundPersonalIdString: string | null = null; 
    if (data && Array.isArray(data) && data.length > 0) {
      if (data[0].claims && Array.isArray(data[0].claims)) {
        const claim = data[0].claims.find(c => c.ename === 'personalId');
        if (claim && claim.value) { foundPersonalIdString = claim.value; }
      }
    }

    // 8. (Step 21 - Sub-Case B2) 成功，但找不到 personalId (異常)
    if (!foundPersonalIdString) {
      const updatedLog = await prisma.verificationLog.update({
        where: { id: log.id },
        data: { status: VerificationStatus.error_missing_uuid, verifyResult: true, resultDescription: '驗證成功，但資料缺少 personalId', returnedData: returnedData },
      });
      return res.status(200).json({ status: updatedLog.status, message: updatedLog.resultDescription, data: returnedData });
    }

    // 9. (Step 21) 完美成功，找到 personalId，存入 DB
    const { updatedLog, personId } = await prisma.$transaction(async (tx) => {
      const person = await tx.person.findUnique({
        where: { personalId: foundPersonalIdString as string },
        select: { id: true }
      });

      let personId: bigint | null = null;
      let finalStatus: VerificationStatus = VerificationStatus.success;
      let finalDescription: string = resultDescription || '驗證成功';

      if (!person) {
        finalStatus = VerificationStatus.error_missing_uuid;
        finalDescription = '驗證成功，但無法在資料庫中關聯使用者';
      } else {
        personId = person.id;
      }

      const updatedLog = await tx.verificationLog.update({
        where: { id: log.id },
        data: {
          status: finalStatus,
          verifyResult: true,
          resultDescription: finalDescription,
          returnedData: returnedData,
          verifiedPersonId: personId,
        },
      });
      return { updatedLog, personId }; // 回傳 personId
    });

    
    // 10. (Step 25) 組合並回傳最終成功結果
    
    // (處理 "DB 找不到此人" 或 "找不到 personalId" 的情況)
    if (updatedLog.status !== VerificationStatus.success || !personId) {
      return res.status(200).json({
          status: updatedLog.status, // error_missing_uuid
          message: updatedLog.resultDescription,
          data: returnedData,
      });
    }

    // [⭐️ 關鍵 ⭐️] 呼叫輔助函式抓取完整資料
    const verificationData = await getVerificationSuccessPayload(personId, returnedData);

    return res.status(200).json({
      status: updatedLog.status, // success
      message: updatedLog.resultDescription,
      verificationData: verificationData, // (回傳完整資料)
    });

  } catch (err) {
    // 11. (Step 19 - 進行中) 處理 Sandbox API 的 "pending" (HTTP 400 / code 4002)
    // ... (此 catch 區塊邏輯不變) ...
    if (axios.isAxiosError(err)) {
      if (err.response?.status === 400 && err.response?.data?.params) {
        try {
          const paramsData = JSON.parse(err.response.data.params);
          if (paramsData.code === 4002) {
            return res.status(200).json({ status: VerificationStatus.initiated, message: '使用者尚未出示憑證' });
          }
        } catch (parseError) { /* ... */ }
      }
      console.error('Sandbox Verifier API Error:', err.response?.data || err.message);
      return res.status(502).json({ message: 'Sandbox API 查詢失敗', error: err.response?.data });
    }
    // 12. 其他所有內部錯誤
    console.error(`[Verifier BE] /check-status/${transactionId} error:`, err);
    return res.status(500).json({ message: '伺服器內部錯誤', error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * [GET] /api/verification/check-batch-status/:uuid
 * (BE-3.C) API 2: 處理「批次驗證」的輪詢
 * (修正 BigInt 錯誤)
 *
 * @param {string} uuid - (來自 URL) 批次工作階段的 UUID
 */
router.get('/check-batch-status/:uuid', async (req, res) => {
  const { uuid } = req.params;
  if (!uuid) {
    return res.status(400).json({ message: '未提供批次工作階段 UUID' });
  }

  try {
    // 1. 查找 Batch Session (不包含 logs)
    const batchSession = await prisma.batchVerificationSession.findUnique({
      where: { uuid: uuid },
    });

    if (!batchSession) {
      return res.status(404).json({ message: '找不到此批次驗證工作階段' });
    }
    
    // 2. 查找所有 "initiated" 的 Logs
    const initiatedLogs = await prisma.verificationLog.findMany({
      where: {
        batchVerificationSessionId: batchSession.id,
        status: VerificationStatus.initiated,
      },
    });

    // 3. [⭐️ 關鍵 ⭐️] 並行 (Parallel) 輪詢所有 "initiated" 的 Logs
    const pollingPromises = initiatedLogs.map(log => pollAndUpdateBatchLog(log));
    await Promise.allSettled(pollingPromises);

    // 4. (Step 26) 輪詢結束後，抓取 "所有" 已完成的 Logs 並組合回傳
    const allLogsInSession = await prisma.verificationLog.findMany({
      where: { batchVerificationSessionId: batchSession.id },
      orderBy: { createdAt: 'desc' }, // 讓最新的在最上面
    });
    
    // 5. 格式化 results 陣列
    const results = await Promise.all(
      allLogsInSession.map(async (log) => {
        
        // Case A: 成功
        if (log.status === VerificationStatus.success && log.verifiedPersonId) {
          const verificationData = await getVerificationSuccessPayload(log.verifiedPersonId, log.returnedData);
          if (!verificationData) {
            return {
              status: VerificationStatus.error_missing_uuid,
              message: '關聯的使用者資料已不存在',
              timestamp: log.createdAt,
              logId: log.id.toString(), // [⭐️ 修正 ⭐️]
            };
          }
          return {
            status: VerificationStatus.success,
            message: log.resultDescription,
            verificationData: verificationData,
            timestamp: log.createdAt,
            logId: log.id.toString(), // [⭐️ 修正 ⭐️]
          };
        }

        // Case B: 失敗、過期、或關聯失敗
        if (log.status !== VerificationStatus.initiated) {
          return {
            status: log.status,
            message: log.resultDescription,
            timestamp: log.createdAt,
            logId: log.id.toString(), // [⭐️ 修正 ⭐️]
          };
        }

        // Case C: 仍在進行中
        return {
          status: VerificationStatus.initiated,
          message: '使用者掃描，尚未完成驗證',
          timestamp: log.createdAt,
          logId: log.id.toString(), // [⭐️ 修正 ⭐️]
        };
      })
    );

    // 6. 組合最終回傳
    const responsePayload = {
      sessionInfo: {
        verifierInfo: batchSession.verifierInfo,
        verifierBranch: batchSession.verifierBranch,
        verificationReason: batchSession.verificationReason,
        notes: batchSession.notes,
        status: batchSession.status,
        expiresAt: batchSession.expiresAt,
      },
      results: results,
    };

    // (錯誤發生在此行，因為 responsePayload.results 陣列中含有 BigInt)
    return res.status(200).json(responsePayload);

  } catch (err) {
    console.error(`[Verifier BE] /check-batch-status/${uuid} error:`, err);
    return res.status(500).json({ 
      message: '伺服器內部錯誤',
      error: err instanceof Error ? err.message : String(err) 
    });
  }
});

// 記得 export router
export default router;