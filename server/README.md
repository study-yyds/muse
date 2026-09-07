# @muse/server

Muse 后端（NestJS + Drizzle ORM + Neon PostgreSQL）。

- 开发启动：`pnpm dev`（根目录）；单独 `cd server && npm run start:dev`
- 测试：`npx jest --passWithNoTests`
- 类型检查：`cd server && npx tsc --noEmit`
- 环境变量：复制 `.env.example` 为 `.env`（与 deploy/.env 保持一致）

架构、AI 模块拆分（ai-host / ops 层）见仓库根 CLAUDE.md。
