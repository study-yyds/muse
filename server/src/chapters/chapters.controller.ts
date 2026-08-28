import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  UseGuards,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { ChaptersService } from './chapters.service';
import { AiService } from '../ai/ai.service';
import { AuthGuard } from '../auth/auth.guard';
import { BookOwnerGuard } from '../auth/book-owner.guard';

@UseGuards(AuthGuard, BookOwnerGuard)
@Controller('api/books/:bookId/chapters')
export class ChaptersController {
  constructor(
    private readonly ch: ChaptersService,
    private readonly ai: AiService,
  ) {}

  @Get()
  async list(@Param('bookId') bookId: string) {
    const data = await this.ch.list(bookId);
    return { code: 200, data };
  }

  @Post()
  async create(@Param('bookId') bookId: string, @Body('title') title: string) {
    const data = await this.ch.create(bookId, title);
    return { code: 201, data };
  }

  @Get(':chapterId')
  async get(
    @Param('bookId') bookId: string,
    @Param('chapterId') chapterId: string,
  ) {
    const data = await this.ch.get(chapterId, bookId);
    if (!data) return { code: 404, message: '章节不存在' };
    return { code: 200, data };
  }

  @Put(':chapterId')
  async save(
    @Param('bookId') bookId: string,
    @Param('chapterId') chapterId: string,
    @Body()
    body: {
      content: string;
      word_count: number;
      bound_outline_node_id?: string | null;
    },
    @Req() req: Request,
  ) {
    try {
      await this.ch.save(
        chapterId,
        body.content,
        body.word_count,
        body.bound_outline_node_id,
        bookId,
      );
      // 章节摘要链(长篇):内容 ≥3000 字且较上次摘要增长 ≥1500 字时异步生成,
      // 不阻塞保存;失败静默
      const content = body.content ?? '';
      if (content.length >= 3000) {
        void (async () => {
          try {
            const chapter = await this.ch.get(chapterId, bookId);
            if (
              chapter &&
              content.length - (chapter.summary_at_words ?? 0) >= 1500
            ) {
              await this.ai.summarizeChapter(
                (req as any).user?.user_id,
                chapterId,
                content,
              );
            }
          } catch {
            /* 摘要失败不影响保存 */
          }
        })();
      }
      // 章节事实清单(长篇):≥2000 字时异步提取(内部按增长 ≥1500 字再判),
      // 续写时注入防跨章漂移;失败静默
      if (content.length >= 2000) {
        void this.ai.extractChapterFacts(
          (req as any).user?.user_id,
          bookId,
          chapterId,
          content,
        );
      }
      return { code: 200, message: '已保存' };
    } catch (e: any) {
      return { code: 403, message: e.message };
    }
  }

  @Delete(':chapterId')
  async delete(
    @Param('bookId') bookId: string,
    @Param('chapterId') chapterId: string,
  ) {
    await this.ch.delete(chapterId, bookId);
    return { code: 200, message: '已删除' };
  }
}
