
-----

# 數位憑證 (VC) 模擬平台 - 後端 API

這是一個基於 Node.js、Express 和 Prisma 的後端伺服器，旨在模擬數位憑證 (VC) 的生命週期，包括「簽發 (Issuance)」和「驗證 (Verification)」。

本專案作為一個中介層，負責處理業務邏K輯、管理使用者資料，並與外部的「數位錢包 Sandbox API」進行互動。它同時也為管理員提供了一套完整的後台 API，用於稽核和管理使用者資格。

## 核心功能

* **Part 1: 憑證簽發 (Issuance)**
    * 模擬使用者身份登入。
    * 檢查使用者領取資格（比對 `PersonEligibility` 與 `IssuedVC`）。
    * 呼叫 Sandbox API 產生一次性領取 QR Code。
    * 輪詢 Sandbox API 以確認使用者是否成功領取。

* **Part 2: 憑證驗證 (Verification)**
    * 支援「**單次驗證**」(Single Mode)：產生一次性的驗證 QR Code。
    * 支援「**批次驗證**」(Batch Mode)：產生可重複使用的「工作階段 QR Code」，供多位民眾依序掃描。
    * 輪詢 Sandbox API 以取得驗證結果。
    * 在驗證成功時，回傳詳細的使用者個資（姓名、聯絡人、福利身份等）。

* **Part 3: 後台管理 (Admin)**
    * **總覽儀表板**：統計所有 VC 模板的總資格數、已發行數、待領取數。
    * **名冊管理**：支援分頁和搜尋，列出特定模板下的所有具資格民眾及其領取狀態。
    * **資格註銷**：提供高完整性 (Transactional) 的 API，能在註銷資格的同時，呼叫 Sandbox API 註銷已發行的 VC。
    * **稽核日誌**：提供「簽發日誌」和「驗證日誌」兩個儀表板，支援分頁和搜尋。

## 🛠️ 技術棧 (Tech Stack)

* **Runtime**: Node.js
* **Framework**: Express.js
* **Language**: TypeScript
* **ORM**: Prisma
* **Database**: MySQL
* **Session**: `express-session` (用於模擬 Issuance 流程)
* **HTTP Client**: `axios` (用於呼叫 Sandbox API)
* **QR Code**: `qrcode` (用於生成 Batch Mode 的 QR Code)

## 🚀 專案設置與啟動

### 1. 先決條件

* Node.js (建議 v18 或更高版本)
* npm (或 pnpm / yarn)
* 一個運作中的 MySQL 資料庫

### 2. 安裝

1.  **Clone 儲存庫**
    ```bash
    git clone [您的儲存庫 URL]
    cd [專案目錄]
    ```

2.  **安裝依賴套件**
    ```bash
    npm install
    ```

### 3. 環境變數設定

在專案根目錄建立一個 `.env` 檔案，並填入以下必要的環境變數：

```ini
# 1. 資料庫連線 (Prisma)
# 格式: mysql://[使用者]:[密碼]@[主機]:[埠號]/[資料庫名稱]
DATABASE_URL="mysql://root:password@localhost:3306/wallet_db"

# 2. Express Session 密鑰 (隨機字串)
SESSION_SECRET="YOUR_VERY_STRONG_SESSION_SECRET"

# 3. 簽發 (Issuance) Sandbox API (Part 1)
WALLET_API_BASE="[https://issuer-sandbox.wallet.gov.tw](https://issuer-sandbox.wallet.gov.tw)"
WALLET_API_KEY="YOUR_WALLET_API_KEY"

# 4. 驗證 (Verification) Sandbox API (Part 2)
VERIFIER_API_BASE="[https://verifier-oid4vp.wallet.gov.tw](https://verifier-oid4vp.wallet.gov.tw)"
VERIFIER_API_KEY="YOUR_VERIFIER_API_KEY"

# 5. 本機 App 基礎 URL (用於批次驗證 QR Code)
# (開發時使用 localhost，部署時必須改為您後端的公開 URL)
APP_BASE_URL="http://localhost:3000"
````

### 4\. 資料庫初始化

1.  **套用資料庫遷移 (Migration)**
    (這會讀取 `prisma/schema.prisma` 並建立所有資料表)

    ```bash
    npx prisma migrate dev
    ```

2.  **生成 Prisma Client**
    (每次修改 `schema.prisma` 後都應執行)

    ```bash
    npx prisma generate
    ```

3.  **(選填) 填充種子資料**
    (如果您有 `prisma/seed.ts` 檔案)

    ```bash
    npx prisma db seed
    ```

### 5\. 啟動應用程式

1.  **開發模式 (使用 ts-node-dev 自動重啟)**

    ```bash
    npm run dev
    ```

2.  **生產模式 (Build & Start)**

    ```bash
    npm run build
    npm run start
    ```

-----

## 📖 API 端點 (Endpoints)

以下是本專案提供的所有 API 端點：

### Flow 1: 憑證簽發 (for Issuance Frontend)

| Method | Endpoint | 說明 |
| :--- | :--- | :--- |
| `POST` | `/api/issuance/start-simulation` | 模擬使用者登入，回傳可申領的模板列表。 |
| `POST` | `/api/issuance/request-credential` | 請求申領特定模板，回傳 `qrCode` 和 `transactionId`。 |
| `GET` | `/api/issuance/status/:transactionId` | (前端輪詢) 檢查申領狀態 (initiated, issued, expired)。|

### Flow 2: 憑證驗證 (for Verifier Frontend & App)

| Method | Endpoint | 說明 |
| :--- | :--- | :--- |
| `POST` | `/api/verification/request-verification` | **(核心)** 請求開始驗證。Body 需包含 `verificationMode: "single" \| "batch"`。回傳 QR Code、`expiresAt` 和對應的 ID。 |
| `GET` | `/api/verification/batch/:uuid` | **(App 掃描)** 批次 QR Code 的中介 API。App 掃描後會請求此 API，並被 `302 Redirect` 到 Sandbox deeplink。|
| `GET` | `/api/verification/check-status/:transactionId` | (前端輪詢 - 單次) 檢查**單次**驗證的狀態。成功時回傳 `verificationData`。|
| `GET` | `/api/verification/check-batch-status/:uuid` | (前端輪詢 - 批次) 檢查**批次**工作階段，回傳 `sessionInfo` 和 `results` 列表。|

### Flow 3: 後台管理 (for Admin Frontend)

| Method | Endpoint | 說明 |
| :--- | :--- | :--- |
| `GET` | `/api/v1/admin/templates/stats` | (總覽頁) 取得所有模板的統計資料 (含 `cardImageUrl`)。 |
| `GET` | `/api/v1/admin/templates/:templateId/persons` | (名冊管理) 取得特定模板的民眾名冊 (支援分頁 `?page` 和 `?search`)。 |
| `POST` | `/api/v1/admin/eligibility/revoke` | (名冊管理) **(高風險)** 註銷單一民眾的資格 (包含呼叫 Sandbox)。 |
| `GET` | `/api/v1/admin/logs/issuance` | (簽發日誌) 取得所有簽發事件的稽核日誌 (支援分頁 `?page`)。 |
| `GET` | `/api/v1/admin/logs/verification` | (驗證日誌) 取得所有驗證事件的稽核日誌 (支援分頁 `?page` 和 `?search`)。 |

## DATABASE 資料庫結構

本專案使用 `prisma/schema.prisma` 管理資料庫結構。

### 核心模型 (Models)

  * `Person`: 儲存所有模擬使用者的詳細個資（姓名、地區、緊急聯絡人、審核機關等）。
  * `VCTemplate`: 定義了可用的福利憑證種類（例如：「低收入戶證明」）。
  * `PersonEligibility`: M2M 關聯表，定義了「哪個 `Person` 有資格領取哪個 `VCTemplate`」。
  * `IssuedVC`: 儲存已成功簽發的 VC 紀錄，包含 `status` (issuing, issued, revoked) 和 `benefitLevel`。
  * `IssuanceLog`: 「簽發流程」的日誌，記錄每一次申領嘗試（initiated, user\_claimed, expired）。
  * `BatchVerificationSession`: 「批次驗證」的工作階段（候診間），儲存一個可重複使用的 `uuid` 和3小時效期。
  * `VerificationLog`: 「驗證流程」的日誌，記錄每一次驗證嘗試（無論單次或批次），並在成功時關聯到 `verifiedPersonId`。

<!-- end list -->


### 授權

本專案採用 MIT 開源授權，詳細條款請見 LICENSE。
```
```
