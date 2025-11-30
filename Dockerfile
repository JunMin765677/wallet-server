# --- 階段 1: 編譯 (Builder) ---
FROM node:20-alpine AS builder

WORKDIR /app

# 複製 package.json 和 lock 檔
COPY package.json package-lock.json ./

# 安裝 "所有" 依賴 (包含 devDependencies，例如 prisma CLI)
RUN npm ci

# 複製所有專案檔案
COPY . .

# 執行 Prisma Generate (這裡會成功，因為有 prisma CLI)
RUN npx prisma generate

# 執行 TypeScript 編譯
RUN npm run build


# --- 階段 2: 生產 (Production) ---
FROM node:20-alpine AS production

WORKDIR /app

# 複製 package.json 和 lock 檔
COPY package.json package-lock.json ./

# 複製 prisma schema
COPY prisma ./prisma

# 安裝 "僅" 生產依賴 (這會安裝 @prisma/client，但 postinstall 會失敗)
RUN npm ci --omit=dev

# [--- 關鍵修正 ---]
# 我們從 builder 階段複製已經 "產生好" 的 client 程式碼，
# 覆蓋掉 postinstall 失敗的空 client。
COPY --from=builder /app/node_modules/.prisma/client ./node_modules/.prisma/client

# 複製編譯好的 'dist' 資料夾
COPY --from=builder /app/dist ./dist

# 設定環境變數為 production
ENV NODE_ENV=production

# 聲明容器會監聽 8001
EXPOSE 8001


# 建非 root 使用者
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app
# COPY . /app
# RUN chown -R appuser:appgroup /app

# 之後都用這個 user 執行
USER appuser

# 容器啟動時的預設指令
CMD ["npm", "run", "start"]