import 'express-session';

// 這裡我們擴充 express-session 的 SessionData 介面
// 讓 TypeScript 知道我們的 session 物件中會有一個 personId 欄位
declare module 'express-session' {
  interface SessionData {
    personId?: string; // [FIX] 將 bigint 改為 string，因為 JSON (和 session) 無法儲存 BigInt
  }
}

