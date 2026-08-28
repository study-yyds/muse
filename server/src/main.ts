import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { NestExpressApplication } from '@nestjs/platform-express';
import { JwtService } from '@nestjs/jwt';
import { join } from 'path';
import type { Request, Response, NextFunction } from 'express';
import { startMaintenanceTasks } from './maintenance';
import { setupFileLogging } from './file-logger';

/** 从 Cookie 头手动解析（不引入 cookie-parser 依赖） */
function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(
      part.slice(idx + 1).trim(),
    );
  }
  return out;
}

async function bootstrap() {
  // 错误日志落盘（在 Nest 启动前挂载，捕获启动期错误）
  setupFileLogging();
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.enableCors({
    origin: ['http://localhost:3000', 'http://localhost:3001'],
    credentials: true,
  });

  // API 请求日志：诊断"前端请求未到达后端"类问题（guard 拒绝的 401/429 也记录）
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.path.startsWith('/api')) {
      const start = Date.now();
      res.on('close', () => {
        console.log(
          `[http] ${req.method} ${req.path} -> ${res.statusCode} (${Date.now() - start}ms)`,
        );
      });
    }
    next();
  });

  // /uploads 静态文件鉴权：<img> 标签无法携带 Authorization 头，
  // 因此登录时种 httpOnly Cookie，此处校验后再放行静态资源
  const jwtService = app.get(JwtService);
  app.use('/uploads', (req: Request, res: Response, next: NextFunction) => {
    const token =
      parseCookies(req.headers.cookie)['muse_token'] ??
      (typeof req.query.token === 'string' ? req.query.token : '');
    try {
      const payload = jwtService.verify(token);
      if (!payload?.sub) throw new Error('invalid');
      next();
    } catch {
      res.status(401).json({ code: 401, message: '未登录' });
    }
  });
  // AI 生图静态文件服务
  app.useStaticAssets(join(__dirname, '..', 'public', 'uploads'), {
    prefix: '/uploads/',
  });
  // 定时维护：7 天软删除清理 + 临时文件清理
  startMaintenanceTasks();
  await app.listen(process.env.PORT ?? 3001);
}
void bootstrap();
