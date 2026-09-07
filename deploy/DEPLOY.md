# Muse 部署指南

## 当前生产环境（2026-09 实测）

```
浏览器 ──> Nginx (web 容器, :80 → 宿主机 8081)
             ├── /            → client 静态文件（Vite 构建产物，SPA）
             ├── /api/*       → server:3004（NestJS，SSE 流式，缓冲关闭）
             └── /uploads/*   → server:3004（上传文件）
server 容器: node dist/main.js（DB schema 由开发侧手动维护，无自动化迁移）
数据: Neon PostgreSQL（外部免费层）；uploads/logs 用 Docker volume 持久化
```

**实际部署位置**：Windows 本机 Docker Desktop（WSL2 后端），compose 项目名 `deploy`，访问 http://localhost:8081。

## 首次部署

```bash
cd muse

# 1. 准备环境变量（.env 不入库，见 .env.example，密钥与自己 server/.env 保持一致）
cp deploy/.env.example deploy/.env

# 2. 启动（无镜像时先构建）
docker compose -p deploy -f deploy/docker-compose.yml up -d

# 3. 健康检查
docker compose -p deploy -f deploy/docker-compose.yml ps   # server 应为 (healthy)

# 4. 浏览器访问 http://localhost:8081
```

> **`-p deploy` 必须带**：compose 项目名取当前目录名（muse），与镜像名 `deploy-*` 不匹配将找不到镜像。

## 环境变量表（deploy/.env）

| 变量 | 必填 | 说明 |
|---|---|---|
| `DATABASE_URL` | ✅ | Neon 连接串 |
| `ENCRYPTION_KEY` | ✅ | `openssl rand -hex 32`；有用户数据后**不可再改** |
| `JWT_SECRET` | ✅ | JWT 签名密钥（登录态签发），与本地 server/.env 一致 |
| `AI_PLATFORM_KEY` | ✅ | DeepSeek 等主平台 key |
| `AI_PLATFORM_BASE_URL` | — | 默认 https://api.deepseek.com/v1 |
| `QWEN_API_KEY` / `QWEN_BASE_URL` | — | qwen 模型路由 |
| `VOLCANO_IMAGE_KEY` / `QWEN_IMAGE_URL` | — | 图像生成 |
| `VOLCANO_TTS_KEY` | — | promo 配音（素材包不生成音频） |
| `PORT` | — | 固定 3004，勿改 |

## 更新生产环境

代码在 GitHub（muse/study-yyds），更新流程：

```bash
cd /e/04-study/vibe_coding/legal/muse
git pull origin master          # 拉最新（remote 已配 SSH over 443 通道）

# 重新构建镜像（本机有已缓存的 node/nginx 基础镜像则联网失败也无妨；
# 没有缓存时 Docker Hub 直连不通 → 见下方"网络受限环境"）
docker compose -p deploy -f deploy/docker-compose.yml up -d --build
```

### 网络受限环境（本机直连 Docker Hub 不通）

该网络 DNS 污染 + 境外直连不稳，两种绕过方式：

1. **镜像加速器**：`~/.docker/daemon.json` 加 `"registry-mirrors": ["https://docker.1ms.run"]`（多轮重试可拉全）
2. **镜像导出导入**（Linux 虚拟机/云服务器可拉 Docker Hub 时）：
   ```bash
   # 可连通机器上构建/拉取后
   docker save deploy-server deploy-web -o muse-images.tar
   # 传回本机后
   docker load -i muse-images.tar
   ```

## 日常运维

```bash
# 看日志 / 状态
docker compose -p deploy -f deploy/docker-compose.yml logs -f server
docker compose -p deploy -f deploy/docker-compose.yml ps

# 重启 / 停止
docker compose -p deploy -f deploy/docker-compose.yml restart
docker compose -p deploy -f deploy/docker-compose.yml down

# 备份上传文件（封面/视频/素材包）
docker run --rm -v muse_uploads:/data -v $(pwd)/backup:/backup alpine tar czf /backup/uploads-$(date +%F).tar.gz -C /data .
```

## 迁到云服务器

同套文件原样搬：云服务器装 Docker → `git clone https://github.com/study-yyds/muse.git` → 填 `deploy/.env` → 同上命令启动 → 控制台开 80/8081 端口。云服务器网络不受本机限制，可直连 Docker Hub，流程更简单。

## 常见问题

- **提示镜像找不到**：compose 命令漏了 `-p deploy`，或镜像未导入/未构建
- **SSE 生成中断**：Nginx 已关 `proxy_buffering`、超时 3600s；上传 413 已调 `client_max_body_size 300m`
- **启动报缺环境变量**：对照上方表格检查 deploy/.env（JWT_SECRET 是后来加的，老环境容易漏）
- **GitHub push/pull 失败**：本机直连 github.com 被墙，remote 用 `ssh://git@ssh.github.com:443/study-yyds/muse.git`（SSH over 443 通道），SSH key 需在 GitHub 账号添加
