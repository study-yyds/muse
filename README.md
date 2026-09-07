# Muse

面向中国网文作者的 AI 写作助手。支持番茄/起点长篇、知乎盐选短篇，从创作引导、大纲规划到章节生成、角色塑造、世界设定的全流程 AI 协作。

## 主要功能

- **创作引导**：AI 对话式引导，从一句话想法梳理出设定、梗概、卷纲、章纲；可随时恢复中断的引导对话
- **长篇写作**：章纲自动绑定大纲节点、内容驱动聚焦节点、章节生成（目标/阻碍/爽点/钩子逐项落实）、改写/续写/去 AI 味
- **短篇写作**：知乎盐选向结构（开篇钩子、反转、情感悬置），知乎体一句话包装
- **大纲**：卷纲 + 章纲（细节点/粗节点）分层规划，AI 按引导结论重生成
- **角色**：角色卡（固定字段 + 自定义字段）、AI 角色对话测试、头像生成
- **世界观**：分区管理 + AI 采纳合并
- **写作风格**：8 种内置风格预设（快节奏网文、知乎盐选、历史文、女频文、轻小说、现实向、生活流、意识流）+ 自定义笔风
- **Promo 素材包**：卡片图生成（背景视频烧录字幕/配音 / 卡片素材包 / 解压视频三条模式）
- 其他：订阅计费与到期降级、作品软删除恢复、AI 字数配额、Admin 后台

## 技术栈

| 层 | 技术 |
|---|---|
| 前端 | React 19 + Vite 6 + Tailwind CSS 4 + TanStack Query + TipTap + Zustand + @base-ui |
| 后端 | NestJS 11 + Drizzle ORM + Neon PostgreSQL（neon-http 无事务，补偿模式） |
| AI | DeepSeek（文本，流式 SSE）+ 通义千问 + 火山引擎（TTS/图像），支持用户自定义 API Key |
| 媒体 | ffmpeg-static（卡片/视频渲染）+ @napi-rs/canvas |
| 部署 | Docker Compose（Nginx 反代 + SSE 直通） |

## 项目结构

```
muse/
├── client/          # React 前端（Vite + Tailwind）
├── server/          # NestJS 后端（Drizzle + Neon）
├── shared/          # 前后端共享 TS 类型（@muse/shared）
├── deploy/          # 生产部署（Dockerfile / docker-compose / nginx.conf / .env.example）
└── docs/            # 产品设计文档（PRD / 技术设计 / 设计系统）
```

## 工程亮点

- **单体服务拆分**：ai.service 从 6600+ 行拆为纯函数层 + 4 个 ops 层（AST 驱动提取方法 + Host 接口委托），测试全绿下完成重构
- **SSE 流式生成**：自定义事件（chunk/reasoning/step/done/error）+ AbortController 中断恢复；Nginx 关缓冲反代适配长生成（10-30 分钟）
- **BYOK + 计费**：用户自定义 API Key 用 AES-256-GCM 加密存储，平台 key 兜底；生成字数双口径计费、订阅到期自动降级（admin 手动升级豁免）
- **无事务环境适配**：Neon neon-http 驱动不支持事务 → 顺序执行 + 补偿模式，从"静默失败"到分步可诊断
- **AI 质量工程**：reasoning 模型强制 thinking disabled（防推理耗竭 max_tokens 导致空输出）；改写按原文字数硬性字节预算（防"2 句扩成 1300 字"）；确定性 AI 味检测（不依赖模型自评）
- **UX 性能**：乐观更新 + Tab 会话缓存/预取（切换秒开）；统一停止按钮；promo 视频管线（filter_complex_script 绕过 Windows 8191 字符命令行限制 + GBK stderr 解码 + 平台自适应字体）
- **测试门禁**：253+ 后端用例（NestJS Testing + 纯函数单测）+ 前端 Vitest + 双端 tsc 类型检查

## 本地开发

```bash
pnpm install
pnpm dev            # 前端 :3000 + 后端 :3004（Vite 代理 /api 与 /uploads）
```

要求：Node ≥ 22、pnpm 11。环境变量见 `server/.env.example`（复制为 `server/.env` 填写）。

## 测试与类型检查

```bash
pnpm test                 # 全部测试
cd server && npx jest         # 后端（253+ 用例）
cd client && npx vitest --run # 前端
pnpm typecheck               # 前后端 tsc
```

## 生产部署

Docker Compose 一键部署（Nginx 静态托管 + /api /uploads 反代 + SSE 流式支持），步骤见 [deploy/DEPLOY.md](deploy/DEPLOY.md)：

```bash
cp deploy/.env.example deploy/.env   # 填写密钥
docker compose -p deploy -f deploy/docker-compose.yml up -d --build
# 访问 http://localhost:8081
```

> 注意：`deploy/.env` 与 `server/.env` 不入库（.gitignore 已排除）。Docker Hub/ github.com 直连受限的网络可参考 [deploy/DEPLOY.md](deploy/DEPLOY.md) 的镜像加速与 SSH over 443 通道方案。

## 环境变量（关键项）

| 变量 | 说明 |
|---|---|
| `DATABASE_URL` | Neon PostgreSQL 连接串 |
| `ENCRYPTION_KEY` | 用户 API Key 的 AES-256-GCM 加密密钥（32 字节 hex，有数据后不可改） |
| `JWT_SECRET` | JWT 签名密钥 |
| `AI_PLATFORM_KEY` / `AI_PLATFORM_BASE_URL` | 主文本模型（DeepSeek） |
| `QWEN_API_KEY` / `QWEN_BASE_URL` | qwen 系列模型路由 |
| `VOLCANO_IMAGE_KEY` / `QWEN_IMAGE_URL` | 图像生成 |
| `VOLCANO_TTS_KEY` | 火山 TTS（promo 配音，可选） |

## 免责说明

AI 生成内容版权归属作者；角色/笔风参考仅用于提示词指导。
