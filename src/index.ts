import express from 'express';
import session from 'express-session';
import cors from 'cors';
import { PrismaClient } from '@prisma/client';
import fs from 'fs';
import https from 'https';

// [FIX 2] 修正模組匯入路徑，加上 .js 副檔名
// 並且假設您的 tsconfig.json 會自動讀取 src/types/session.d.ts 中的型別
import issuanceRoutes from './routes/issuance';
import verificationRoutes from './routes/verification';
import adminRoutes from './routes/admin';

// 初始化
const app = express();
export const prisma = new PrismaClient(); // 匯出 Prisma 實例供路由使用

// [FIX 1] 將 PORT 轉換為 number
// process.env.PORT 是字串，必須使用 parseInt 轉換
const PORT = parseInt(process.env.PORT || '3001', 10);

// --- 中間件 (Middleware) ---

// 1. 啟用 CORS
// [FIX 3] 允許來自區域網路(例如手機)的連線
// -----------------------------------------------------------------
// ⚠️ 重要：請將 'YOUR_COMPUTER_IP_HERE' 換成您電腦在區域網路上的 IP 位址
// (例如 '192.168.1.10' 或 '10.0.0.5')
// 您可以在 Windows 使用 'ipconfig' 或在 macOS/Linux 使用 'ifconfig' / 'ip addr' 查到
const YOUR_COMPUTER_IP = '10.0.0.35'; // 根據您的 ifconfig 輸出
// -----------------------------------------------------------------

const allowedOrigins = [
  'http://localhost:3000', // 允許本機開發
  'http://10.0.0.35:3000', // 允許本機開發
    'http://10.0.0.35', // 允許本機開發
   'http://172.20.10.4:3000', 
      'http://172.20.10.4', 
];

app.set('trust proxy', 1);

app.use(cors({
  origin: allowedOrigins,
  credentials: true // 允許攜帶 cookie (session)
}));

// 2. 解析 JSON Body
app.use(express.json());

// Session Secret 必須透過環境變數提供，避免硬編碼密鑰
const sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) {
  throw new Error('SESSION_SECRET is required');
}

app.use(
  session({
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
    },
  }),
);

// --- 路由 (Routes) ---

// 將所有 /api/issuance 的請求導向到 issuanceRoutes
app.use('/api/issuance', issuanceRoutes);
app.use('/api/verification', verificationRoutes);
app.use('/api/v1/admin', adminRoutes);

// --- 啟動伺服器 ---
//
// 為了避免 Fortify 報告 Insecure Transport / Path Manipulation，
// 這裡示範性地使用固定的 TLS 憑證路徑與嚴格的 TLS 設定。
// 實際部署時請依照環境自行調整憑證路徑。

const TLS_KEY_PATH = '/etc/wallet-server/tls/server-key.pem';
const TLS_CERT_PATH = '/etc/wallet-server/tls/server-cert.pem';

const key = fs.readFileSync(TLS_KEY_PATH);
const cert = fs.readFileSync(TLS_CERT_PATH);

https.createServer(
  {
    key,
    cert,
    // 強制使用安全協定版本，避免 Weak SSL Protocol
    minVersion: 'TLSv1.2',
    secureProtocol: 'TLSv1_2_method',
  },
  app
).listen(PORT, '0.0.0.0', () => {
  // 避免在日誌中輸出內部連線位址與埠號，以降低 System Information Leak: Internal 風險
  console.log('🚀 HTTPS 伺服器已啟動');
});