import {
  Controller,
  Post,
  Get,
  Query,
  Body,
  Res,
  Req,
  Param,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import path from 'path';
import { writeFile, mkdir } from 'fs/promises';
import crypto from 'crypto';
import { PromoService } from './promo.service';
import { AuthGuard } from '../auth/auth.guard';
import { BookOwnerGuard } from '../auth/book-owner.guard';
import { RateLimitGuard } from '../auth/rate-limit.guard';

const promoRateLimit = new RateLimitGuard(10, 300_000); // 每5分钟10次（素材包不调外部API，放宽）

@UseGuards(AuthGuard, BookOwnerGuard)
@Controller('api/books/:bookId/promo')
export class PromoController {
  constructor(private readonly promo: PromoService) {}

  // 音色试听：不占视频生成配额，按音色缓存（同一音色只消耗一次 API 调用）
  @Get('preview-voice')
  async previewVoice(
    @Param('bookId') bookId: string,
    @Query('voice_type') voiceType: string,
    @Req() req: Request,
  ) {
    if (!voiceType || voiceType.length > 200) {
      throw new BadRequestException('缺少或非法的 voice_type');
    }
    const url = await this.promo.previewVoice(voiceType, (req as any).userId);
    return { code: 200, data: { url } };
  }

  @UseGuards(promoRateLimit)
  @Post('generate')
  async generate(
    @Param('bookId') bookId: string,
    @Body()
    body: {
      script_text: string;
      voice_type?: string;
      mode?: 'background' | 'pack';
      background_url?: string;
    },
    @Res() res: Response,
    @Req() req: Request,
  ) {
    await this.promo.generatePromoVideo(res, {
      scriptText: body.script_text,
      voiceType: body.voice_type || 'zh_female_xiaohe_uranus_bigtts',
      userId: (req as any).userId,
      bookId,
      mode: body.mode || 'background',
      backgroundUrl: body.background_url,
    });
  }

  @UseGuards(promoRateLimit)
  @Post('upload-background')
  async uploadBackground(@Req() req: Request) {
    // 原生 multipart 解析（只支持单文件字段 video）
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', resolve);
      req.on('error', reject);
    });

    const raw = Buffer.concat(chunks);
    const contentType = req.headers['content-type'] || '';
    const boundaryMatch = contentType.match(/boundary=(.+)/);
    if (!boundaryMatch) {
      throw new BadRequestException('需要 multipart/form-data');
    }
    const boundary = boundaryMatch[1].replace(/^"|"$/g, '');
    const boundaryBuf = Buffer.from(`--${boundary}`);

    // 解析文件部分
    let fileBuffer: Buffer | null = null;
    let pos = raw.indexOf(boundaryBuf);
    while (pos !== -1) {
      const headerEnd = raw.indexOf(Buffer.from('\r\n\r\n'), pos);
      if (headerEnd === -1) break;
      const header = raw.slice(pos, headerEnd).toString();
      if (header.includes('filename=') && header.includes('Content-Type')) {
        const nextBoundary = raw.indexOf(boundaryBuf, headerEnd + 4);
        const endPos =
          nextBoundary !== -1
            ? raw.lastIndexOf(Buffer.from('\r\n'), nextBoundary)
            : raw.length;
        fileBuffer = raw.slice(headerEnd + 4, endPos);
        break;
      }
      pos = raw.indexOf(boundaryBuf, headerEnd + 4);
    }

    if (!fileBuffer || fileBuffer.length === 0) {
      throw new BadRequestException('未找到上传的视频文件');
    }
    if (fileBuffer.length > 100 * 1024 * 1024) {
      throw new BadRequestException('背景视频不能超过 100MB');
    }
    // 文件头校验：MP4 必须含 ftyp box（防改后缀的任意文件）
    const header = fileBuffer.subarray(4, 8).toString('ascii');
    if (header !== 'ftyp') {
      throw new BadRequestException('仅支持 MP4 视频文件');
    }

    const uploadsDir = path.join(
      __dirname,
      '..',
      '..',
      'public',
      'uploads',
      'videos',
    );
    await mkdir(uploadsDir, { recursive: true });
    const filename = `bg-${crypto.randomUUID()}.mp4`;
    await writeFile(path.join(uploadsDir, filename), fileBuffer);

    return { code: 200, data: { url: `/uploads/videos/${filename}` } };
  }
}
