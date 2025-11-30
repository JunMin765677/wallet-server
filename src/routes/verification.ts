// src/routes/verification.ts
import { Router } from 'express';
import { prisma } from '../index';
import { VerificationStatus, IssuanceStatus, BatchVerificationStatus } from '@prisma/client';
import type { 
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
// === Helper 區 ===

async function markLogExpired(logId: bigint | number) {
  await prisma.verificationLog.update({
    where: { id: logId },
    data: { status: VerificationStatus.expired },
  });
}

function isLogExpired(log: VerificationLog): boolean {
  return !!log.expiresAt && new Date() > log.expiresAt;
}

async function callVerifierResultApi(log: VerificationLog) {
  const apiBase = process.env.VERIFIER_API_BASE;
  const apiKey = process.env.VERIFIER_API_KEY;
  // 這裡照你原本註解，不另外檢查 env

  return axios.post(
    `${apiBase}/api/oidvp/result`,
    { transactionId: log.transactionId },
    {
      headers: {
        'Access-Token': apiKey,
        'Content-Type': 'application/json',
        accept: '*/*',
      },
    }
  );
}

async function updateLogAsVerifyFailed(
  logId: bigint | number,
  description: string,
  returnedData?: unknown
) {
  await prisma.verificationLog.update({
    where: { id: logId },
    data: {
      status: VerificationStatus.failed,
      verifyResult: false,
      resultDescription: description,
      returnedData,
    },
  });
}

function extractPersonalIdFromResult(data: any): string | null {
  if (!data || !Array.isArray(data) || data.length === 0) {
    return null;
  }
  const first = data[0];
  if (!first.claims || !Array.isArray(first.claims)) {
    return null;
  }

  const claim = first.claims.find((c: any) => c.ename === 'personalId');
  if (claim && claim.value) {
    return String(claim.value);
  }
  return null;
}

async function handleVerificationSuccess(
  log: VerificationLog,
  vpResult: VpResultResponse,
  returnedData: unknown
) {
  const personalId = extractPersonalIdFromResult(vpResult.data);

  // 6. 找不到 personalId
  if (!personalId) {
    await prisma.verificationLog.update({
      where: { id: log.id },
      data: {
        status: VerificationStatus.error_missing_uuid,
        verifyResult: true,
        resultDescription: '驗證成功，但資料缺少 personalId',
        returnedData,
      },
    });
    return;
  }

  // 7. 完美成功 (transaction 裡更新、關聯 person)
  await prisma.$transaction(async (tx) => {
    const person = await tx.person.findUnique({
      where: { personalId },
      select: { id: true },
    });

    if (!person) {
      await tx.verificationLog.update({
        where: { id: log.id },
        data: {
          status: VerificationStatus.error_missing_uuid,
          verifyResult: true,
          resultDescription:
            '驗證成功，但無法在資料庫中關聯使用者',
          returnedData,
          verifiedPersonId: null,
        },
      });
    } else {
      await tx.verificationLog.update({
        where: { id: log.id },
        data: {
          status: VerificationStatus.success,
          verifyResult: true,
          resultDescription: vpResult.resultDescription || '驗證成功',
          returnedData,
          verifiedPersonId: person.id,
        },
      });
    }
  });
}

function isPendingErrorFromAxios(err: any): boolean {
  if (!err.response?.status || !err.response?.data?.params) {
    return false;
  }

  if (err.response.status !== 400) return false;

  try {
    const rawParams = err.response.data.params;
    const parsed =
      typeof rawParams === 'string'
        ? JSON.parse(rawParams)
        : rawParams;
    return parsed?.code === 4002;
  } catch {
    return false;
  }
}

async function handlePollAxiosError(
  logId: bigint | number,
  err: any
): Promise<void> {
  if (isPendingErrorFromAxios(err)) {
    // 狀態為 initiated / pending，什麼都不做
    return;
  }

  // 其他 Sandbox 錯誤 -> 標記為 failed
  await prisma.verificationLog.update({
    where: { id: logId },
    data: {
      status: VerificationStatus.failed,
      resultDescription: 'Sandbox 輪詢錯誤',
    },
  });
}

async function handlePollUnknownError(logId: bigint | number) {
  await prisma.verificationLog.update({
    where: { id: logId },
    data: {
      status: VerificationStatus.failed,
      resultDescription: '內部輪詢錯誤',
    },
  });
}


// === 重構後的主函式 ===

async function pollAndUpdateBatchLog(log: VerificationLog) {
  // 1. 檢查是否已過期 (Log 本身)
  if (isLogExpired(log)) {
    await markLogExpired(log.id);
    return;
  }

  try {
    // 2. 呼叫 Sandbox API
    const apiResponse = await callVerifierResultApi(log);

    // 3. Sandbox 成功回傳
    const vpResult = apiResponse.data as VpResultResponse;
    const returnedData = apiResponse.data;
    const { verifyResult, resultDescription } = vpResult;

    // 4. 驗證失敗
    if (verifyResult === false) {
      await prisma.verificationLog.update({
        where: { id: log.id },
        data: {
          status: VerificationStatus.failed,
          verifyResult: false,
          resultDescription: resultDescription || '驗證失敗',
          returnedData,
        },
      });
      return;
    }

    // 5–7. 驗證成功相關處理（含 personalId 判斷與 DB 更新）
    await handleVerificationSuccess(log, vpResult, returnedData);
  } catch (err) {
    if (axios.isAxiosError(err)) {
      await handlePollAxiosError(log.id, err);
    } else {
      await handlePollUnknownError(log.id);
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
/** ========= 型別 & 自訂錯誤 ========= */

type VerificationMode = 'single' | 'batch';

interface VerificationRequestBody {
  verificationMode: VerificationMode;
  role: string;
  verifier: string;
  reason: string;
  notes?: string;
}

class RequestVerificationError extends Error {
  constructor(
    public code:
      | 'MISSING_FIELDS'
      | 'INVALID_MODE'
      | 'ENV_VERIFIER_API'
      | 'ENV_APP_BASE',
    message: string
  ) {
    super(message);
  }
}

/** ========= 小工具函式 ========= */

function parseVerificationRequestBody(body: any): VerificationRequestBody {
  const {
    verificationMode,
    role,
    verifier,
    reason,
    notes,
  } = body as VerificationRequestBody;

  if (!role || !verifier || !reason) {
    throw new RequestVerificationError(
      'MISSING_FIELDS',
      'role (角色), verifier (單位), reason (目的) 均為必填'
    );
  }

  if (!['single', 'batch'].includes(verificationMode)) {
    throw new RequestVerificationError(
      'INVALID_MODE',
      '未提供有效的 verificationMode ("single" 或 "batch")'
    );
  }

  return { verificationMode, role, verifier, reason, notes };
}

function getVerifierApiEnv() {
  const apiBase = process.env.VERIFIER_API_BASE;
  const apiKey = process.env.VERIFIER_API_KEY;

  if (!apiBase || !apiKey) {
    throw new RequestVerificationError(
      'ENV_VERIFIER_API',
      '伺服器設定錯誤 (VERIFIER_API)'
    );
  }

  return { apiBase, apiKey };
}

function getAppBaseUrlEnv() {
  const appBaseUrl = process.env.APP_BASE_URL;
  if (!appBaseUrl) {
    throw new RequestVerificationError(
      'ENV_APP_BASE',
      '伺服器設定錯誤 (APP_BASE_URL)'
    );
  }
  return appBaseUrl;
}

/** ========= 單次驗證 flow ========= */

async function startSingleVerification(
  payload: VerificationRequestBody
) {
  const { role, verifier, reason, notes } = payload;
  const { apiBase, apiKey } = getVerifierApiEnv();

  const transactionId = uuidv4();
  const fixedRef = '00000000_template001';

  const apiResponse = await axios.get(
    `${apiBase}/api/oidvp/qrcode`,
    {
      params: { ref: fixedRef, transactionId },
      headers: {
        'Access-Token': apiKey,
        accept: '*/*',
      },
    }
  );

  const { qrcodeImage, authUri } = apiResponse.data;
  if (!qrcodeImage || !authUri) {
    throw new Error('Sandbox API 回傳資料不完整');
  }

  const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // +5 分鐘

  await prisma.verificationLog.create({
    data: {
      transactionId,
      verifierInfo: role,
      verifierBranch: verifier,
      verificationReason: reason,
      notes: notes ?? null,
      status: VerificationStatus.initiated,
      expiresAt,
      batchVerificationSessionId: null,
    },
  });

  return {
    type: 'single' as const,
    transactionId,
    qrCode: qrcodeImage,
    deepLink: authUri,
    expiresAt: expiresAt.toISOString(),
  };
}

/** ========= 批次驗證 flow ========= */

async function startBatchVerification(
  payload: VerificationRequestBody
) {
  const { role, verifier, reason, notes } = payload;
  const appBaseUrl = getAppBaseUrlEnv();

  const expiresAt = new Date(Date.now() + 3 * 60 * 60 * 1000); // +3 小時

  const newSession = await prisma.batchVerificationSession.create({
    data: {
      verifierInfo: role,
      verifierBranch: verifier,
      verificationReason: reason,
      notes: notes ?? null,
      status: BatchVerificationStatus.active,
      expiresAt,
    },
  });

  const batchUrl = `${appBaseUrl}/api/verification/batch/${newSession.uuid}`;
  const qrCodeImage = await qrcode.toDataURL(batchUrl);

  return {
    type: 'batch' as const,
    batchSessionUuid: newSession.uuid,
    qrCode: qrCodeImage,
    expiresAt: expiresAt.toISOString(),
  };
}

/** ========= 錯誤處理集中 ========= */

function handleRequestVerificationError(
  err: unknown,
  res: Response
) {

  if (err instanceof RequestVerificationError) {
    const statusMap: Record<RequestVerificationError['code'], number> = {
      MISSING_FIELDS: 400,
      INVALID_MODE: 400,
      ENV_VERIFIER_API: 500,
      ENV_APP_BASE: 500,
    };
    return res
      .status(statusMap[err.code])
      .json({ message: err.message });
  }

  if (axios.isAxiosError(err)) {
    return res.status(502).json({
      message: '呼叫 Sandbox 驗證 API 失敗',
      error: err.response?.data,
    });
  }

  return res.status(500).json({
    message: '伺服器內部錯誤',
    error: err instanceof Error ? err.message : String(err),
  });
}

/** ========= Route 本體（瘦版） ========= */

router.post(
  '/request-verification',
  async (req: Request, res: Response) => {
    try {
      const payload = parseVerificationRequestBody(req.body);

      if (payload.verificationMode === 'single') {
        const result = await startSingleVerification(payload);
        return res.status(200).json(result);
      }

      const result = await startBatchVerification(payload);
      return res.status(200).json(result);
    } catch (err) {
      return handleRequestVerificationError(err, res);
    }
  }
);

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
    if (axios.isAxiosError(err)) {
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
class CheckStatusError extends Error {
  constructor(
    public httpStatus: number,
    public body: any
  ) {
    super(body?.message || '');
  }
}

/** ========= 小工具函式 ========= */

function parseTransactionId(req: Request): string {
  const { transactionId } = req.params;
  if (!transactionId) {
    throw new CheckStatusError(400, { message: '未提供 transactionId' });
  }
  return transactionId;
}

async function findVerificationLogOrThrow(transactionId: string) {
  const log = await prisma.verificationLog.findUnique({
    where: { transactionId },
  });

  if (!log) {
    throw new CheckStatusError(404, { message: '找不到此驗證流程' });
  }

  return log;
}

function isLogExpired(log: any): boolean {
  return !!log.expiresAt && new Date() > log.expiresAt;
}

async function markLogExpiredAndBuildResponse(log: any) {
  const updatedLog = await prisma.verificationLog.update({
    where: { id: log.id },
    data: { status: VerificationStatus.expired },
  });

  return {
    httpStatus: 200,
    body: {
      status: updatedLog.status,
      message: '驗證流程已過期',
    },
  };
}

async function buildCompletedLogResponse(log: any) {
  // 已完成的 Log（非 initiated）
  if (log.status === VerificationStatus.success && log.verifiedPersonId) {
    const verificationData = await getVerificationSuccessPayload(
      log.verifiedPersonId,
      log.returnedData
    );

    if (!verificationData) {
      return {
        httpStatus: 404,
        body: {
          status: log.status,
          message: '驗證成功，但關聯的使用者資料已不存在',
        },
      };
    }

    return {
      httpStatus: 200,
      body: {
        status: log.status,
        message: log.resultDescription,
        verificationData,
      },
    };
  }

  // failed, expired, error_missing_uuid...
  return {
    httpStatus: 200,
    body: {
      status: log.status,
      message: log.resultDescription || '驗證流程已結束',
      data: log.returnedData,
    },
  };
}

function getVerifierApiEnvForCheck() {
  const apiBase = process.env.VERIFIER_API_BASE;
  const apiKey = process.env.VERIFIER_API_KEY;
  if (!apiBase || !apiKey) {
    throw new CheckStatusError(500, {
      message: '伺服器設定錯誤 (VERIFIER_API)',
    });
  }
  return { apiBase, apiKey };
}


async function updateLogOnVerifyFailed(
  log: any,
  resultDescription: string | undefined,
  returnedData: unknown
) {
  const updatedLog = await prisma.verificationLog.update({
    where: { id: log.id },
    data: {
      status: VerificationStatus.failed,
      verifyResult: false,
      resultDescription: resultDescription || '驗證失敗',
      returnedData,
    },
  });

  return {
    httpStatus: 200,
    body: {
      status: updatedLog.status,
      message: updatedLog.resultDescription,
    },
  };
}

async function runVerificationSuccessTransaction(
  log: any,
  foundPersonalIdString: string,
  resultDescription: string | undefined,
  returnedData: unknown
) {
  const { updatedLog, personId } = await prisma.$transaction(
    async (tx) => {
      const person = await tx.person.findUnique({
        where: { personalId: foundPersonalIdString },
        select: { id: true },
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
          returnedData,
          verifiedPersonId: personId,
        },
      });

      return { updatedLog, personId };
    }
  );

  // 組合最終回應
  if (updatedLog.status !== VerificationStatus.success || !personId) {
    return {
      httpStatus: 200,
      body: {
        status: updatedLog.status,
        message: updatedLog.resultDescription,
        data: returnedData,
      },
    };
  }

  const verificationData = await getVerificationSuccessPayload(
    personId,
    returnedData
  );

  return {
    httpStatus: 200,
    body: {
      status: updatedLog.status,
      message: updatedLog.resultDescription,
      verificationData,
    },
  };
}

function isPendingErrorFromAxiosForCheck(err: any): boolean {
  if (err.response?.status !== 400 || !err.response?.data?.params) {
    return false;
  }

  try {
    const rawParams = err.response.data.params;
    const parsed =
      typeof rawParams === 'string'
        ? JSON.parse(rawParams)
        : rawParams;
    return parsed?.code === 4002;
  } catch {
    return false;
  }
}

function handleAxiosErrorForCheckStatus(err: any, transactionId: string) {
  if (isPendingErrorFromAxiosForCheck(err)) {
    return {
      httpStatus: 200,
      body: {
        status: VerificationStatus.initiated,
        message: '使用者尚未出示憑證',
      },
    };
  }

  return {
    httpStatus: 502,
    body: {
      message: 'Sandbox API 查詢失敗',
      error: err.response?.data,
    },
  };
}

async function buildCheckStatusResponse(
  log: any,
  transactionId: string
): Promise<{ httpStatus: number; body: any }> {
  // 2. 若不是 initiated，表示已完成
  if (log.status !== VerificationStatus.initiated) {
    return buildCompletedLogResponse(log);
  }

  // 3. 檢查是否已過期
  if (isLogExpired(log)) {
    return markLogExpiredAndBuildResponse(log);
  }

  // 4. 呼叫 Sandbox API 輪詢
  const { apiBase, apiKey } = getVerifierApiEnvForCheck();

  const apiResponse = await axios.post(
    `${apiBase}/api/oidvp/result`,
    { transactionId },
    {
      headers: {
        'Access-Token': apiKey,
        'Content-Type': 'application/json',
        accept: '*/*',
      },
    }
  );

  // 5. Sandbox API 成功回傳
  const vpResult = apiResponse.data as VpResultResponse;
  const returnedData = apiResponse.data;
  const { data, verifyResult, resultDescription } = vpResult;

  // 6. 驗證失敗
  if (verifyResult === false) {
    return updateLogOnVerifyFailed(log, resultDescription, returnedData);
  }

  // 7–9. 驗證成功 → 取 personalId → transaction 更新 & 組合回應
  const foundPersonalIdString = extractPersonalIdFromResult(data);

  if (!foundPersonalIdString) {
    const updatedLog = await prisma.verificationLog.update({
      where: { id: log.id },
      data: {
        status: VerificationStatus.error_missing_uuid,
        verifyResult: true,
        resultDescription: '驗證成功，但資料缺少 personalId',
        returnedData,
      },
    });

    return {
      httpStatus: 200,
      body: {
        status: updatedLog.status,
        message: updatedLog.resultDescription,
        data: returnedData,
      },
    };
  }

  return runVerificationSuccessTransaction(
    log,
    foundPersonalIdString,
    resultDescription,
    returnedData
  );
}

/** ========= Route 本體（瘦版） ========= */

router.get(
  '/check-status/:transactionId',
  async (req: Request, res: Response) => {
    let transactionId = '';
    try {
      transactionId = parseTransactionId(req);
      const log = await findVerificationLogOrThrow(transactionId);

      const result = await buildCheckStatusResponse(log, transactionId);
      return res.status(result.httpStatus).json(result.body);
    } catch (err) {
      if (err instanceof CheckStatusError) {
        return res.status(err.httpStatus).json(err.body);
      }

      if (axios.isAxiosError(err)) {
        const result = handleAxiosErrorForCheckStatus(
          err,
          transactionId
        );
        return res.status(result.httpStatus).json(result.body);
      }

      return res.status(500).json({
        message: '伺服器內部錯誤',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
);

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
    return res.status(500).json({ 
      message: '伺服器內部錯誤',
      error: err instanceof Error ? err.message : String(err) 
    });
  }
});

// 記得 export router
export default router;