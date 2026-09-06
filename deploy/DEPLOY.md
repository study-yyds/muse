# Muse 部署指南（单机 Docker）

一套配置通用：本地 Linux 机器 / 云服务器，迁云只需搬 `deploy/` 目录和源码。

## 架构

```
浏览器 ──> Nginx (web 容器, :80)
             ├── /            → client 静态文件（Vite 构建产物，SPA）
             ├── /api/*       → server:3004（NestJS，SSE 流式，缓冲关闭）
             └── /uploads/*   → server:3004（上传文件）
server 容器: 启动时自动跑 drizzle 迁移 → node dist/main.js
数据: Neon PostgreSQL（外部，免费层）；uploads/logs 用 Docker volume 持久化
```

## 前置条件

1. Linux 机器装 Docker Engine + compose 插件（`docker compose version` 能跑）
2. 机器能访问外网（Neon DB、AI API）
3. 代码传到 Linux 机器（`git clone` 或 scp；`pnpm-lock.yaml` 必须带上）

## 首次部署

```bash
cd muse

# 1. 准备环境变量（不要提交 deploy/.env 到 git）
cp deploy/.env.example deploy/.env
vim deploy/.env   # 填 DATABASE_URL / ENCRYPTION_KEY / AI keys

# 2. 构建并启动（首次构建约 5-10 分钟）
docker compose -f deploy/docker-compose.yml up -d --build

# 3. 看启动日志（迁移 + Nest 启动）
docker compose -f deploy/docker-compose.yml logs -f server
# 看到 "Nest application successfully started" 即成功

# 4. 浏览器访问 http://<机器IP> 登录使用
```

## 日常运维

```bash
cd muse

# 更新代码后重新部署
git pull
docker compose -f deploy/docker-compose.yml up -d --build

# 看日志 / 状态
docker compose -f deploy/docker-compose.yml logs -f server
docker compose -f deploy/docker-compose.yml ps

# 备份上传文件（封面/视频/素材包）
docker run --rm -v muse_uploads:/data -v $(pwd)/backup:/backup alpine tar czf /backup/uploads-$(date +%F).tar.gz -C /data .
```

## 环境变量说明（deploy/.env）

| 变量 | 必填 | 说明 |
|---|---|---|
| `DATABASE_URL` | ✅ | Neon 连接串 |
| `ENCRYPTION_KEY` | ✅ | `openssl rand -hex 32`；有用户数据后**不可再改** |
| `AI_PLATFORM_KEY` | ✅ | DeepSeek 等主平台 key |
| `AI_PLATFORM_BASE_URL` | — | 默认 https://api.deepseek.com/v1 |
| `QWEN_API_KEY` / `QWEN_BASE_URL` | — | qwen 模型路由用 |
| `VOLCANO_IMAGE_KEY` / `QWEN_IMAGE_URL` | — | 图像生成 |
| `VOLCANO_TTS_KEY` | — | promo 配音（素材包不生成音频） |
| `PORT` | — | 固定 3004，勿改 |

## 常见问题

- **web 起来了但接口 502**：server 还在迁移/启动，`docker compose logs server` 看进度
- **上传大文件 413**：已把 `client_max_body_size` 调到 300m
- **SSE 生成中断**：Nginx 已关 `proxy_buffering`、超时 3600s
- **迁移失败**：检查 `DATABASE_URL` 是否能从该机器连通 Neon（Neon 需要 IP 白名单或确认不限来源）
- **字体乱码/卡片无字幕**：镜像内已装 `fonts-noto-cjk`

## 迁到云服务器

1. 云服务器装 Docker
2. 把整个 `muse/` 目录传上去（`deploy/.env` 单独传，不传 node_modules）
3. 同样跑 `docker compose -f deploy/docker-compose.yml up -d --build`
4. 云控制台开 80 端口；有域名则 DNS 解析到云 IP（国内服务器绑定域名需备案）
