import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.enableCors({
    origin: ['http://localhost:3000', 'http://localhost:3001'],
    credentials: true,
  });
  // AI 生图静态文件服务
  app.useStaticAssets(join(__dirname, '..', 'public', 'uploads'), { prefix: '/uploads/' });
  await app.listen(process.env.PORT ?? 3001);
}
void bootstrap();
