import express from 'express';
import session from 'express-session';
import cors from 'cors';
import { PrismaClient } from '@prisma/client';

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

const sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) {
  // dev 環境可以給預設，但 production 建議直接 throw
  if (process.env.NODE_ENV === 'production') {
    throw new Error('SESSION_SECRET is required in production');
  }
}

app.use(
  session({
    secret: sessionSecret || 'dev-only-secret',
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

// [FIX 2] 監聽 0.0.0.0
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Express 伺服器已啟動於 http://0.0.0.0:${PORT}`);
  console.log(`   (本機也可透過 http://localhost:${PORT} 存取)`);
});