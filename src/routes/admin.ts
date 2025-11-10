import { Router } from 'express';
// (請確保您的 prisma client import 路徑正確)
import { prisma } from '../index';
import { Prisma, IssuanceStatus, IssuanceLogStatus, VerificationStatus } from '@prisma/client';
import axios from 'axios';
const router = Router();

/**
 * [GET] /api/v1/admin/templates/stats
 * (BE-1) (總覽頁) 取得所有 Template 及其統計 API
 * (更新版：加入 cardImageUrl)
 */
router.get('/templates/stats', async (req, res) => {
  try {
    // 1. 取得所有 VCTemplates
    // [⭐️ 變更 ⭐️] 新增 select: { cardImageUrl: true }
    const templatesPromise = prisma.vCTemplate.findMany({
      select: { 
        id: true, 
        templateName: true, 
        cardImageUrl: true // ⬅️ 新增此欄位
      },
    });

    // 2. [聚合] 取得 "總共資格" 數量
    const eligibleCountsPromise = prisma.personEligibility.groupBy({
      by: ['templateId'],
      _count: { _all: true },
    });

    // 3. [聚合] 取得 "已簽發" 數量
    const issuedCountsPromise = prisma.issuedVC.groupBy({
      by: ['templateId'],
      where: { status: IssuanceStatus.issued },
      _count: { _all: true },
    });

    // 4. 並行 (Parallel) 執行所有查詢
    const [templates, eligibleCounts, issuedCounts] = await Promise.all([
      templatesPromise,
      eligibleCountsPromise,
      issuedCountsPromise,
    ]);

    // 5. 將聚合結果轉換為 Map
    const eligibleMap = new Map(
      eligibleCounts.map(c => [c.templateId, c._count._all])
    );
    const issuedMap = new Map(
      issuedCounts.map(c => [c.templateId, c._count._all])
    );

    // 6. 合併結果
    const responseData = templates.map(template => {
      const totalEligible = eligibleMap.get(template.id) || 0;
      const totalIssued = issuedMap.get(template.id) || 0;
      const totalPending = totalEligible - totalIssued;

      return {
        id: template.id,
        templateName: template.templateName,
        cardImageUrl: template.cardImageUrl, // [⭐️ 變更 ⭐️] 
        stats: {
          totalEligible: totalEligible,
          totalIssued: totalIssued,
          totalPending: totalPending < 0 ? 0 : totalPending,
        }
      };
    });

    return res.status(200).json(responseData);

  } catch (err) {
    console.error('[Admin BE] /templates/stats error:', err);
    return res.status(500).json({ 
      message: '伺服器內部錯誤',
      error: err instanceof Error ? err.message : String(err)
    });
  }
});

/**
 * [GET] /api/v1/admin/templates/:templateId/persons
 * (BE-2) (詳細頁) 依 Template 取得民眾名冊 (支援分頁與搜尋)
 * (更新版：回傳 VCTemplate.templateName 和所有 Person 欄位)
 *
 * Query Params:
 * ?page=1
 * ?limit=20
 * ?search=王大明
 */
router.get('/templates/:templateId/persons', async (req, res) => {
  try {
    // --- 1. 解析 URL 參數和 Query ---
    const templateId = parseInt(req.params.templateId);
    if (isNaN(templateId)) {
      return res.status(400).json({ message: '無效的 templateId' });
    }

    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const skip = (page - 1) * limit;
    const search = req.query.search as string;

    // --- 2. 建立動態 WHERE 條件 ---
    let where: Prisma.PersonWhereInput = {
      eligibilities: {
        some: {
          templateId: templateId,
        },
      },
    };
    if (search) {
      where = {
        AND: [
          where,
          {
            OR: [
              { name: { contains: search } },
              { nationalId: { contains: search } },
              { personalId: { contains: search } },
            ],
          },
        ],
      };
    }

    // --- 3. 執行平行查詢 (Template 名稱, 總數, 當頁資料) ---
    
    // (查詢 1: 取得 Template 名稱)
    const templatePromise = prisma.vCTemplate.findUnique({
      where: { id: templateId },
      select: { templateName: true },
    });
    
    // (查詢 2: 取得總數)
    const totalPersonsPromise = prisma.person.count({ where });

    // (查詢 3: 取得當頁資料)
    // [⭐️ 變更 ⭐️] 使用 'include' 抓取所有 Person 欄位
    const personsPromise = prisma.person.findMany({
      where,
      include: {
        // [⭐️ 變更 ⭐️] 僅 Select status，移除 issuedAt, benefitLevel
        issuedVCs: {
          where: {
            templateId: templateId,
          },
          select: {
            status: true,
          },
        },
      },
      take: limit,
      skip: skip,
      orderBy: { name: 'asc' },
    });

    const [template, totalPersons, persons] = await Promise.all([
      templatePromise,
      totalPersonsPromise,
      personsPromise,
    ]);

    if (!template) {
      return res.status(404).json({ message: '找不到指定的 Template' });
    }

    // --- 4. 資料格式轉換 (符合 FE 要求的格式) ---
    const data = persons.map(person => {
      let displayedVc = null;

      if (person.issuedVCs.length > 0) {
        const vc = person.issuedVCs.find(vc => 
          vc.status === IssuanceStatus.issued || vc.status === IssuanceStatus.issuing
        ) || person.issuedVCs[0];
        
        // [⭐️ 變更 ⭐️] issuedVc 物件現在非常簡潔
        displayedVc = { 
          status: vc.status 
        };
      }

      // (移除 'issuedVCs' 輔助欄位，避免回傳)
      const { issuedVCs, ...personData } = person;

      // [⭐️ 變更 ⭐️] 手動組合回傳物件，確保 BigInt 欄位被轉為 String
      return {
        // (Person 的所有欄位)
        personId: personData.id.toString(), // 覆蓋 BigInt
        name: personData.name,
        personalId: personData.personalId,
        nationalId: personData.nationalId,
        county: personData.county,
        district: personData.district,
        address: personData.address,
        phoneNumber: personData.phoneNumber,
        dateOfBirth: personData.dateOfBirth,
        emergencyContactName: personData.emergencyContactName,
        emergencyContactRelationship: personData.emergencyContactRelationship,
        emergencyContactPhone: personData.emergencyContactPhone,
        reviewingAuthority: personData.reviewingAuthority,
        reviewerName: personData.reviewerName,
        reviewerPhone: personData.reviewerPhone,
        eligibilityStartDate: personData.eligibilityStartDate,
        eligibilityEndDate: personData.eligibilityEndDate,
        // (BigInt 財產欄位 -> String)
        personalAnnualIncome: personData.personalAnnualIncome?.toString() || null,
        personalMovableAssets: personData.personalMovableAssets?.toString() || null,
        personalRealEstateAssets: personData.personalRealEstateAssets?.toString() || null,
        familyAnnualIncome: personData.familyAnnualIncome?.toString() || null,
        familyMovableAssets: personData.familyMovableAssets?.toString() || null,
        familyRealEstateAssets: personData.familyRealEstateAssets?.toString() || null,
        createdAt: personData.createdAt,
        updatedAt: personData.updatedAt,
        
        // (VC 狀態)
        issuedVc: displayedVc
      };
    });

    // --- 5. 建立分頁物件 ---
    const totalPages = Math.ceil(totalPersons / limit);
    const pagination = {
      total: totalPersons,
      totalPages: totalPages,
      currentPage: page,
      limit: limit,
    };

    // --- 6. 回傳最終結果 ---
    // [⭐️ 變更 ⭐️] 在最頂層回傳 templateName
    return res.status(200).json({
      templateName: template.templateName,
      pagination,
      data,
    });

  } catch (err) {
    console.error(`[Admin BE] /templates/${req.params.templateId}/persons error:`, err);
    return res.status(500).json({ 
      message: '伺服器內部錯誤',
      error: err instanceof Error ? err.message : String(err)
    });
  }
});

/**
 * [POST] /api/v1/admin/eligibility/revoke
 * (BE-3) "註銷資格" 核心 API (Transaction)
 *
 * Body: { personId: string, templateId: number, reason: string }
 */
router.post('/eligibility/revoke', async (req, res) => {
  const { personId, templateId, reason } = req.body as {
    personId: string; // (來自 BE-2 的回傳，應為 string)
    templateId: number;
    reason: string;
  };

  // --- 1. Validation ---
  if (!personId || !templateId) {
    return res.status(400).json({ message: 'personId 和 templateId 為必填' });
  }

  let personIdBigInt: bigint;
  try {
    // (將 JSON 的 string 轉回 BigInt)
    personIdBigInt = BigInt(personId); 
  } catch (e) {
    return res.status(400).json({ message: '無效的 personId 格式' });
  }

  // (取得 Sandbox API 環境變數)
  const apiBase = process.env.WALLET_API_BASE;
  const apiKey = process.env.WALLET_API_KEY;

  if (!apiBase || !apiKey) {
    console.error('[Admin BE] WALLET_API .env variables not set');
    return res.status(500).json({ message: '伺服器設定錯誤 (Wallet API Key)' });
  }

  // --- 2. 啟動 Transaction ---
  try {
    await prisma.$transaction(async (tx) => {
      
      // 步驟 1: 找出所有 "已簽發" (issued) 且 "有 cid" 的 VCs
      // (這才是需要呼叫 Sandbox API 的對象)
      const vcsToRevokeInSandbox = await tx.issuedVC.findMany({
        where: {
          personId: personIdBigInt,
          templateId: templateId,
          status: IssuanceStatus.issued,
          cid: { not: null }, // 確保 cid 存在
        },
        select: {
          cid: true,
        }
      });

      // 步驟 2: [⭐️ 關鍵 ⭐️] 遍歷並呼叫 Sandbox API 註銷
      // (使用 Promise.all 確保所有 Sandbox 請求都成功)
      const revokePromises = vcsToRevokeInSandbox.map(vc => {
        if (vc.cid) {
          return axios.put(
            `${apiBase}/api/credential/${vc.cid}/revocation`,
            {}, // (PUT 請求，通常 body 為空)
            {
              headers: {
                'Access-Token': apiKey,
                'accept': '*/*',
              },
            }
          );
        }
        return Promise.resolve(); // (理論上不會發生，因為 a.cid.not = null)
      });
      
      // (如果 vcsToRevokeInSandbox 是空陣列，這裡會立刻 resolve)
      // (如果任何一個 Sandbox 請求失敗，這裡會 throw，並觸發 $transaction Rollback)
      await Promise.all(revokePromises);

      // 步驟 3: (Sandbox 成功後) 更新 "所有" 本地 DB 的 VCs 狀態為 'revoked'
      // (包含 'issued', 'issuing', 'expired' 等，一併註銷)
      await tx.issuedVC.updateMany({
        where: {
          personId: personIdBigInt,
          templateId: templateId,
        },
        data: {
          status: IssuanceStatus.revoked,
          // (未來也可在此加註 reason)
        }
      });

      // 步驟 4: 刪除 "資格"
      // (使用 deleteMany 較為穩健，即使紀錄已不存在也不會報錯)
      await tx.personEligibility.deleteMany({
        where: {
          personId: personIdBigInt,
          templateId: templateId,
        }
      });

      // (TODO: 建議的 Step 5 - 寫入 AdminAuditLog)
      // await tx.adminAuditLog.create({ 
      //   data: { 
      //     action: 'revoke_eligibility', 
      //     targetPersonId: personIdBigInt, 
      //     targetTemplateId: templateId, 
      //     reason: reason 
      //   } 
      // });
    });

    // --- 3. Transaction 成功 ---
    return res.status(200).json({ message: '資格與憑證已成功註銷' });

  } catch (err) {
    // --- 4. Transaction 失敗 ---
    console.error(`[Admin BE] /eligibility/revoke Transaction error:`, err);

    // (Case 1: Sandbox API 呼叫失敗)
    if (axios.isAxiosError(err)) {
      return res.status(502).json({ 
        message: 'Sandbox API 註銷失敗，本地資料庫未做任何變更', 
        error: err.response?.data 
      });
    }

    // (Case 2: 資料庫操作失敗)
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      return res.status(500).json({ message: '資料庫註銷操作失敗', code: err.code });
    }

    // (Case 3: 其他錯誤)
    return res.status(500).json({ 
      message: '伺服器內部錯誤',
      error: err instanceof Error ? err.message : String(err)
    });
  }
});

/**
 * [GET] /api/v1/admin/logs/issuance
 * (BE-1) (日誌頁) 取得簽發日誌 API (支援分頁)
 * (更新版：精確後製處理 "expired" 狀態)
 *
 * Query Params:
 * ?page=1
 * ?limit=20
 */
router.get('/logs/issuance', async (req, res) => {
  try {
    // --- 1. 解析分頁參數 ---
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const skip = (page - 1) * limit;

    // --- 2. 執行平行查詢 (取得總數 & 取得當頁資料) ---
    
    // (查詢 1: 取得總數)
    const totalLogsPromise = prisma.issuanceLog.count();

    // (查詢 2: 取得當頁資料)
    const logsPromise = prisma.issuanceLog.findMany({
      select: {
        id: true,
        // status: true, // (我們將不再使用 DB 中的 log.status)
        createdAt: true,
        expiresAt: true, // [⭐️ 變更 ⭐️] 查詢 expiresAt
        issuedVC: {
          select: { 
            status: true, // (DB 中的 VC status: issued, issuing, revoked)
            issuedAt: true, // [⭐️ 變更 ⭐️] 查詢 issuedAt
            systemUuid: true,
            person: {
              select: { name: true, county: true, district: true },
            },
            template: {
              select: { templateName: true, cardImageUrl: true },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' }, 
      skip: skip,
      take: limit,
    });

    const [totalLogs, logs] = await Promise.all([
      totalLogsPromise,
      logsPromise,
    ]);

    // --- 3. 建立分頁物件 ---
    const totalPages = Math.ceil(totalLogs / limit);
    const pagination = {
      totalItems: totalLogs,
      totalPages: totalPages,
      currentPage: page,
      limit: limit,
    };

    // --- 4. 資料格式轉換 (並執行 "後製處理") ---
    const data = logs.map(log => {
      
      // [⭐️ 關鍵變更 ⭐️]
      // 根據 'issuedAt' 和 'expiresAt' 推導 "真實" 狀態
      
      let finalLogStatus: IssuanceLogStatus | 'expired';
      let finalVcStatus: IssuanceStatus | 'expired';

      if (log.issuedVC?.issuedAt) {
        // 1. 已領取 (issuedAt 存在)
        // 狀態只可能是 'issued' 或 'revoked'
        finalLogStatus = IssuanceLogStatus.user_claimed;
        finalVcStatus = log.issuedVC.status; // (DB 狀態 'issued' or 'revoked')

      } else {
        // 2. 未領取 (issuedAt 為 null)
        if (log.expiresAt && new Date() > new Date(log.expiresAt)) {
          // 2a. 未領取 且 已過期
          finalLogStatus = 'expired'; // 自定義 "過期" 狀態
          finalVcStatus = 'expired'; // 自定義 "過期" 狀態
        } else {
          // 2b. 未領取 且 未過期
          finalLogStatus = IssuanceLogStatus.initiated; // (處理中)
          finalVcStatus = IssuanceStatus.issuing;      // (發行中)
        }
      }

      // 複製 issuedVC 物件並覆蓋 status
      const processedIssuedVC = log.issuedVC ? {
        ...log.issuedVC,
        status: finalVcStatus, // [⭐️ 覆蓋 ⭐️]
      } : null;

      return {
        // IssuanceLog 欄位
        id: log.id.toString(), // (BigInt -> String)
        status: finalLogStatus,  // [⭐️ 覆蓋 ⭐️] (Log 狀態)
        createdAt: log.createdAt,
        
        // 巢狀 VC (狀態已被覆蓋)
        issuedVC: processedIssuedVC
      };
    });

    // --- 5. 回傳最終結果 ---
    return res.status(200).json({
      pagination,
      data: data,
    });

  } catch (err) {
    console.error('[Admin BE] /logs/issuance error:', err);
    return res.status(500).json({ 
      message: '伺服器內部錯誤',
      error: err instanceof Error ? err.message : String(err)
    });
  }
});


/**
 * [GET] /api/v1/admin/logs/verification
 * (BE-1) (驗證日誌頁) 取得驗證日誌
 * (更新版：支援 "單一搜尋框" 篩選與分頁)
 *
 * Query Params:
 * ?page=1
 * ?limit=20
 * ?search=... (關鍵字)
 */
router.get('/logs/verification', async (req, res) => {
  try {
    // --- 1. 解析參數 ---
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const skip = (page - 1) * limit;

    // [⭐️ 變更 ⭐️]
    // (讀取單一 search 參數)
    const search = req.query.search as string;

    // --- 2. 建立動態 WHERE 條件 ---
    const where: Prisma.VerificationLogWhereInput = {
      // (基礎條件：只撈取已 "完成" 的紀錄)
      status: {
        in: [
          VerificationStatus.success,
          VerificationStatus.failed,
          VerificationStatus.expired,
          VerificationStatus.error_missing_uuid,
        ]
      }
    };
    
    // [⭐️ 變更 ⭐️]
    // (如果提供了 'search' 關鍵字，建立一個複雜的 'AND' / 'OR' 篩選)
    if (search) {
      const searchCondition: Prisma.VerificationLogWhereInput = {
        OR: [
          // 1. 驗證機構 (verifierBranch)
          { verifierBranch: { contains: search } },
          
          // 2. 機構類別 (verifierInfo)
          { verifierInfo: { contains: search } },
          
          // 3. 驗證目的 (verificationReason)
          { verificationReason: { contains: search } },
          
          // 4. 驗證民眾 (Person.name) - (巢狀搜尋)
          { verifiedPerson: { name: { contains: search } } },

          // 5. 驗證的福利身份 (VCTemplate.templateName) - (巢狀搜尋)
          {
            verifiedPerson: {
              issuedVCs: {
                some: {
                  template: {
                    templateName: { contains: search },
                  }
                }
              }
            }
          }
        ]
      };
      
      // (將搜尋條件與基礎條件 (status) 結合)
      where.AND = [searchCondition];
    }

    // --- 3. 執行平行查詢 (取得總數 & 取得當頁資料) ---
    
    // (查詢 1: 取得總數)
    const totalLogsPromise = prisma.verificationLog.count({ where });

    // (查詢 2: 取得當頁資料)
    const logsPromise = prisma.verificationLog.findMany({
      where,
      select: {
        id: true,
        createdAt: true,
        verifierBranch: true,
        verifierInfo: true,
        verificationReason: true,
        notes: true,
        verifyResult: true,
        verifiedPerson: {
          select: {
            name: true,
            county: true,
            district: true,
            issuedVCs: {
              where: { status: IssuanceStatus.issued },
              select: {
                template: {
                  select: {
                    templateName: true
                  }
                }
              }
            }
          }
        }
      },
      orderBy: { createdAt: 'desc' },
      skip: skip,
      take: limit,
    });

    const [totalLogs, logs] = await Promise.all([
      totalLogsPromise,
      logsPromise,
    ]);

    // --- 4. 建立分頁物件 ---
    const totalPages = Math.ceil(totalLogs / limit);
    const pagination = {
      totalItems: totalLogs,
      totalPages: totalPages,
      currentPage: page,
      limit: limit,
    };

    // --- 5. 資料格式轉換 (邏輯不變) ---
    const data = logs.map(log => {
      let personName: string | null = null;
      let personArea: string | null = null;
      let verifiedIdentities: string[] = [];

      if (log.verifiedPerson) {
        personName = log.verifiedPerson.name;
        personArea = `${log.verifiedPerson.county || ''}${log.verifiedPerson.district || ''}`;
        verifiedIdentities = log.verifiedPerson.issuedVCs.map(
          vc => vc.template.templateName
        );
      }
      
      return {
        id: log.id.toString(),
        verifiedAt: log.createdAt,
        agencyName: log.verifierBranch,
        agencyType: log.verifierInfo,
        purpose: log.verificationReason,
        notes: log.notes,
        personName: personName,
        personArea: personArea,
        result: log.verifyResult,
        verifiedIdentities: verifiedIdentities,
      }
    });

    // --- 6. 回傳最終結果 ---
    return res.status(200).json({
      pagination,
      data: data,
    });

  } catch (err) {
    console.error('[Admin BE] /logs/verification error:', err);
    return res.status(500).json({ 
      message: '伺服器內部錯誤',
      error: err instanceof Error ? err.message : String(err)
    });
  }
});


export default router;