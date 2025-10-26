# 產生遷移 & apply
npx prisma migrate dev --name init
# 生成 TypeScript Client
npx prisma generate
# 查看資料（內建 Studio）
npx prisma studio