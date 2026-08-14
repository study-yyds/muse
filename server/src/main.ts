import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
import { startMaintenanceTasks } from './maintenance';
import { setupFileLogging } from './file-logger';

async function bootstrap() {
  // 错误日志落盘（在 Nest 启动前挂载，捕获启动期错误）
  setupFileLogging();
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.enableCors({
    origin: ['http://localhost:3000', 'http://localhost:3001'],
    credentials: true,
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
