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
type WalletEnv = {
  apiBase: string;
  apiKey: string;
};

type IssuanceTransactionResult = {
  qrCode: string;
  deepLink: string;
  transactionId: string;
};

class IssuanceError extends Error {
  constructor(
    public code:
      | 'UNAUTHORIZED'
      | 'INVALID_TEMPLATE_ID'
      | 'ENV_MISSING'
      | 'PERSON_NOT_FOUND'
      | 'TEMPLATE_NOT_FOUND'
      | 'VCUID_MISSING'
      | 'SANDBOX_INCOMPLETE',
    message: string
  ) {
    super(message);
  }
}

/** ==== 小工具 function 區 ==== */

function extractIdsFromRequest(req: Request): {
  personId: bigint;
  templateId: number;
  systemUuid: string;
} {
  const personIdStr = req.session.personId;
  const { templateId } = req.body as { templateId?: unknown };

  if (!personIdStr) {
    throw new IssuanceError(
      'UNAUTHORIZED',
      '您尚未開始模擬身份驗證，請重新操作'
    );
  }

  if (typeof templateId !== 'number') {
    throw new IssuanceError(
      'INVALID_TEMPLATE_ID',
      '未提供有效的 templateId (必須是數字)'
    );
  }

  const personId = BigInt(personIdStr);
  const systemUuid = uuidv4().replace(/-/g, '_');

  return { personId, templateId, systemUuid };
}

function getWalletEnv(): WalletEnv {
  const apiBase = process.env.WALLET_API_BASE;
  const apiKey = process.env.WALLET_API_KEY;

  if (!apiBase || !apiKey) {
    throw new IssuanceError(
      'ENV_MISSING',
      '伺服器設定錯誤，無法呼叫簽發 API'
    );
  }

  return { apiBase, apiKey };
}

function buildIssuedData(
  templateId: number,
  systemUuid: string,
  person: {
    name: string | null;
    personalId: string | null;
    emergencyContactName: string | null;
    emergencyContactRelationship: string | null;
    emergencyContactPhone: string | null;
    reviewingAuthority: string | null;
    reviewerName: string | null;
    reviewerPhone: string | null;
  }
) {
  const benefitLevel = generateBenefitLevel(templateId);

  return {
    benefitLevel,
    issuedData: {
      name: person.name,
      personalId: person.personalId,
      system_uuid: systemUuid,
      benefitLevel,
      emergencyContactName: person.emergencyContactName ?? '',
      emergencyContactRelationship: person.emergencyContactRelationship ?? '',
      emergencyContactPhone: person.emergencyContactPhone ?? '',
      reviewingAuthority: person.reviewingAuthority ?? '',
      reviewerName: person.reviewerName ?? '',
      reviewerPhone: (person.reviewerPhone ?? '').replace(/-/g, ''),
    },
  };
}

function buildIssuancePayload(
  vcUid: string,
  issuedData: Record<string, unknown>
) {
  const today = new Date();
  const issuanceDate = [
    today.getFullYear(),
    String(today.getMonth() + 1).padStart(2, '0'),
    String(today.getDate()).padStart(2, '0'),
  ].join('');

  const fields = Object.entries(issuedData).map(([key, value]) => ({
    ename: key,
    content: String(value ?? ''),
  }));

  return {
    vcUid,
    issuanceDate,
    expiredDate: '20251231',
    fields,
  };
}

async function callSandboxIssue(
  apiBase: string,
  apiKey: string,
  payload: unknown
): Promise<IssuanceTransactionResult> {
  const apiResponse = await axios.post(
    `${apiBase}/api/qrcode/data`,
    payload,
    {
      headers: {
        'Access-Token': apiKey,
        'Content-Type': 'application/json',
        accept: 'application/json',
      },
    }
  );

  const { transactionId, qrCode, deepLink } = apiResponse.data ?? {};

  if (!transactionId || !qrCode || !deepLink) {
    throw new IssuanceError(
      'SANDBOX_INCOMPLETE',
      'Sandbox API 回傳資料不完整'
    );
  }

  return { transactionId, qrCode, deepLink };
}

async function runIssuanceTransaction(params: {
  personId: bigint;
  templateId: number;
  systemUuid: string;
  apiBase: string;
  apiKey: string;
}): Promise<IssuanceTransactionResult> {
  const { personId, templateId, systemUuid, apiBase, apiKey } = params;

  return prisma.$transaction(async (tx) => {
    // 1. 撈 person / template
    const [person, template] = await Promise.all([
      tx.person.findUnique({
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
      }),
      tx.vCTemplate.findUnique({
        where: { id: templateId },
        select: { vcUid: true },
      }),
    ]);

    if (!person) {
      throw new IssuanceError('PERSON_NOT_FOUND', 'Person not found');
    }
    if (!template) {
      throw new IssuanceError('TEMPLATE_NOT_FOUND', 'Template not found');
    }
    if (!template.vcUid) {
      throw new IssuanceError('VCUID_MISSING', 'Template vcUid is missing');
    }

    // 2. 組 issuedData / benefitLevel
    const { issuedData, benefitLevel } = buildIssuedData(
      templateId,
      systemUuid,
      person
    );

    // 3. 建立 IssuedVC 紀錄
    const newIssuedVC = await tx.issuedVC.create({
      data: {
        systemUuid,
        personId,
        templateId,
        status: IssuanceStatus.issuing,
        issuedData,
        benefitLevel,
      },
    });

    // 4. 呼叫 Sandbox API
    const payload = buildIssuancePayload(template.vcUid, issuedData);
    const { transactionId, qrCode, deepLink } = await callSandboxIssue(
      apiBase,
      apiKey,
      payload
    );

    // 5. 建立 IssuanceLog
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await tx.issuanceLog.create({
      data: {
        transactionId,
        status: IssuanceLogStatus.initiated,
        expiresAt,
        issuedVcId: newIssuedVC.id,
      },
    });

    return { transactionId, qrCode, deepLink };
  });
}

function handleRequestCredentialError(err: unknown, res: Response) {

  if (err instanceof IssuanceError) {
    switch (err.code) {
      case 'UNAUTHORIZED':
        return res.status(401).json({ message: err.message });
      case 'INVALID_TEMPLATE_ID':
        return res.status(400).json({ message: err.message });
      case 'ENV_MISSING':
        return res.status(500).json({ message: err.message });
      case 'PERSON_NOT_FOUND':
        return res
          .status(404)
          .json({ message: '找不到對應的使用者資料' });
      case 'TEMPLATE_NOT_FOUND':
        return res
          .status(404)
          .json({ message: '找不到對應的 VC 模板' });
      case 'VCUID_MISSING':
        return res
          .status(400)
          .json({ message: 'VC 模板設定不完整 (缺少 vcUid)' });
      case 'SANDBOX_INCOMPLETE':
        return res
          .status(502)
          .json({ message: 'Sandbox API 回傳資料不完整' });
    }
  }

  if (axios.isAxiosError(err)) {
    return res.status(502).json({
      message: '呼叫 Sandbox API 失敗',
      error: err.response?.data,
    });
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    return res.status(500).json({
      message: '資料庫操作失敗',
      code: err.code,
    });
  }

  return res.status(500).json({ message: '伺服器內部錯誤' });
}

/** ==== 路由 handler 本體（被大幅瘦身）==== */

router.post('/request-credential', async (req: Request, res: Response) => {
  try {
    console.log('[request-credential] 請求開始。');
    console.log(
      '[request-credential] 收到的 headers.cookie:',
      req.headers.cookie
    );
    console.log(
      '[request-credential] 收到的 session 物件:',
      JSON.stringify(req.session)
    );

    const ids = extractIdsFromRequest(req);
    const env = getWalletEnv();

    const result = await runIssuanceTransaction({
      ...ids,
      ...env,
    });

    return res.status(200).json(result);
  } catch (err) {
    return handleRequestCredentialError(err, res);
  }
});

/**
 * @route   GET /api/issuance/status/:transactionId
 * @desc    (Step 15-18) FE 輪詢此 API 檢查 VC 領取狀態 (更新版)
 * @param   {string} transactionId - 要查詢的交易 ID
 */
class StatusRouteError extends Error {
  constructor(
    public code:
      | 'UNAUTHORIZED'
      | 'MISSING_TRANSACTION_ID'
      | 'NOT_FOUND'
      | 'ENV_MISSING'
      | 'NO_CREDENTIAL'
      | 'INVALID_JWT'
      | 'NO_CID',
    message: string
  ) {
    super(message);
  }
}

function getPersonIdFromSession(req: any): bigint {
  const personIdStr = req.session?.personId;
  if (!personIdStr) {
    throw new StatusRouteError(
      'UNAUTHORIZED',
      'Session 遺失，請重新操作'
    );
  }
  return BigInt(personIdStr);
}

function getTransactionIdFromParams(req: any): string {
  const { transactionId } = req.params as { transactionId?: string };
  if (!transactionId) {
    throw new StatusRouteError(
      'MISSING_TRANSACTION_ID',
      '未提供 transactionId'
    );
  }
  return transactionId;
}

async function findActiveIssuanceLog(personId: bigint, transactionId: string) {
  const activeLog = await prisma.issuanceLog.findUnique({
    where: {
      transactionId: transactionId,
      issuedVC: {
        personId: personId,
      },
    },
    include: {
      issuedVC: true,
    },
  });

  if (!activeLog) {
    throw new StatusRouteError(
      'NOT_FOUND',
      '找不到此簽發流程，或您無權查詢'
    );
  }

  return activeLog;
}

function getFinalStatusResponse(activeLog: any):
  | { status: 'issued' | 'expired'; message: string }
  | null {
  if (activeLog.status === IssuanceLogStatus.user_claimed) {
    return { status: 'issued', message: '已領取成功' };
  }
  if (activeLog.status === IssuanceLogStatus.expired) {
    return { status: 'expired', message: '簽發流程已過期' };
  }
  return null;
}

async function handleExpiryIfNeeded(activeLog: any): Promise<boolean> {
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
    return true;
  }
  return false;
}

function getWalletEnvForStatus() {
  const apiBase = process.env.WALLET_API_BASE;
  const apiKey = process.env.WALLET_API_KEY;

  if (!apiBase || !apiKey) {
    throw new StatusRouteError(
      'ENV_MISSING',
      '伺服器環境變數設定不完整'
    );
  }

  return { apiBase, apiKey };
}

function decodeCidFromCredential(credentialJWT: string): string {
  const decoded = jwtDecode(credentialJWT);
  if (!decoded || typeof decoded !== 'object' || !(decoded as any).jti) {
    throw new StatusRouteError(
      'INVALID_JWT',
      '解析 JWT 失敗或缺少 jti'
    );
  }

  const jti = (decoded as any).jti as string;
  const cid = jti.split('credential/').pop();

  if (!cid) {
    throw new StatusRouteError(
      'NO_CID',
      '無法從 jti 解析出 CID'
    );
  }

  return cid;
}

async function checkSandboxAndUpdateStatus(
  transactionId: string,
  activeLog: any
): Promise<{ status: 'issued'; message: string }> {
  const { apiBase, apiKey } = getWalletEnvForStatus();

  const apiResponse = await axios.get(
    `${apiBase}/api/credential/nonce/${transactionId}`,
    {
      headers: {
        'Access-Token': apiKey,
        accept: '*/*',
      },
    }
  );

  const credentialJWT = apiResponse.data?.credential;
  if (!credentialJWT) {
    throw new StatusRouteError(
      'NO_CREDENTIAL',
      'Sandbox API 回傳 200 OK 但缺少 credential'
    );
  }

  const cid = decodeCidFromCredential(credentialJWT);

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

  return { status: 'issued', message: '領取成功' };
}

function handleStatusRouteError(err: unknown, req: any, res: Response) {
  if (err instanceof StatusRouteError) {
    const statusMap: Record<StatusRouteError['code'], number> = {
      UNAUTHORIZED: 401,
      MISSING_TRANSACTION_ID: 400,
      NOT_FOUND: 404,
      ENV_MISSING: 500,
      NO_CREDENTIAL: 502,
      INVALID_JWT: 500,
      NO_CID: 500,
    };

    return res
      .status(statusMap[err.code])
      .json({ message: err.message });
  }

  if (axios.isAxiosError(err)) {
    if (err.response?.data?.code === '61010') {
      // 使用者尚未領取
      return res.status(200).json({
        status: 'initiated',
        message: '使用者尚未領取',
      });
    }

    return res.status(502).json({
      message: 'Sandbox API 查詢失敗',
      error: err.response?.data,
    });
  }

  return res.status(500).json({
    message: '伺服器內部錯誤',
    error: err instanceof Error ? err.message : String(err),
  });
}

/** ========= 路由本體（大幅瘦身） ========= */

router.get('/status/:transactionId', async (req: any, res: Response) => {
  try {
    const personId = getPersonIdFromSession(req);
    const transactionId = getTransactionIdFromParams(req);

    const activeLog = await findActiveIssuanceLog(personId, transactionId);

    const finalStatus = getFinalStatusResponse(activeLog);
    if (finalStatus) {
      // 已是 issued / expired，不用再呼叫 Sandbox
      return res.status(200).json(finalStatus);
    }

    const isExpired = await handleExpiryIfNeeded(activeLog);
    if (isExpired) {
      return res
        .status(200)
        .json({ status: 'expired', message: '簽發流程已過期' });
    }

    const result = await checkSandboxAndUpdateStatus(
      transactionId,
      activeLog
    );
    return res.status(200).json(result);
  } catch (err) {
    return handleStatusRouteError(err, req, res);
  }
});

export default router;
