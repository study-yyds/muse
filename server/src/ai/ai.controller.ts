import {
  Controller,
  Post,
  Get,
  Put,
  Delete,
  Body,
  Res,
  Req,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AiService } from './ai.service';
import { AuthGuard } from '../auth/auth.guard';
import { RateLimitGuard } from '../auth/rate-limit.guard';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../database/connection';

const aiRateLimit = new RateLimitGuard(10, 60_000); // 每分钟10次

@UseGuards(AuthGuard)
@Controller('api/ai')
export class AiController {
  constructor(private readonly ai: AiService) {}

  @UseGuards(aiRateLimit)
  @Post('generate')
  async generate(@Body() body: any, @Res() res: Response, @Req() req: Request) {
    body.user_id = (req as any).userId;
    await this.ai.generate(res, body);
  }

  @UseGuards(aiRateLimit)
  @Post('chat')
  async chat(
    @Body()
    body: {
      book_id?: string;
      context_type: string;
      message: string;
      messages?: any[];
      model?: string;
      chapter_id?: string;
      cursor_position?: number;
      style?: string;
      guide_mode?: boolean;
      guide_context?: string;
      guide_type?: string;
    },
    @Res() res: Response,
    @Req() req: Request,
  ) {
    try {
      await this.ai.chat(res, {
        ...body,
        book_id: body.book_id ?? '',
        user_id: (req as any).userId,
      });
    } catch (e: any) {
      console.error('[chat controller] error:', e.message ?? e);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 500, message: 'AI 服务异常' }));
      }
    }
  }

  @UseGuards(aiRateLimit)
  @Post('mimic-style')
  async mimicStyle(
    @Body() body: { book_id?: string; model?: string; text?: string },
    @Req() req: Request,
  ) {
    if (body.book_id) {
      await this.ai.checkBookOwnership(body.book_id, (req as any).userId);
    }
    const data = await this.ai.mimicStyle(
      body.book_id,
      body.model ?? 'deepseek-v4-flash',
      body.text,
      (req as any).userId,
    );
    return { code: 200, data };
  }

  @UseGuards(aiRateLimit)
  @Post('apply-settings')
  async applySettings(
    @Body()
    body: {
      book_id: string;
      suggestions: Array<{
        type: 'character' | 'world';
        target_char_id?: string | null;
        field?: string;
        value?: string;
        section_name?: string;
        content?: string;
      }>;
    },
    @Req() req: Request,
  ) {
    const data = await this.ai.applySettings(
      body.book_id,
      body.suggestions,
      (req as any).userId,
    );
    return { code: 200, data };
  }

  // ============== 会话管理 ==============

  @Get('chat-sessions/:bookId')
  async getSessions(
    @Param('bookId') bookId: string,
    @Query('section') section: string,
    @Req() req: Request,
  ) {
    const userId = (req as any).userId;
    const isGuide = bookId === 'guide';
    if (!isGuide) await this.ai.checkBookOwnership(bookId, userId);
    if (!section) {
      return { code: 200, data: null };
    }
    const active = await this.ai.getActiveSession(
      isGuide ? null : bookId,
      section,
      isGuide ? userId : undefined,
    );
    const all = await this.ai.getSessions(
      isGuide ? null : bookId,
      section,
      isGuide ? userId : undefined,
    );
    return { code: 200, data: { active, sessions: all } };
  }

  @Post('chat-sessions')
  async createSession(
    @Body()
    body: {
      book_id?: string | null;
      section: string;
      title?: string;
    },
    @Req() req: Request,
  ) {
    const data = await this.ai.createSession(
      body.book_id === 'guide' ? null : (body.book_id ?? null),
      body.section,
      body.title ?? new Date().toLocaleDateString('zh-CN'),
      (req as any).userId,
    );
    return { code: 200, data };
  }

  @Put('chat-sessions/:sessionId/messages')
  async updateMessages(
    @Param('sessionId') sessionId: string,
    @Body() body: { messages: any[] },
    @Req() req: Request,
  ) {
    await this.ai.updateSessionMessages(
      sessionId,
      body.messages,
      (req as any).userId,
    );
    return { code: 200, message: '已保存' };
  }

  @Put('chat-sessions/:sessionId/restore')
  async restoreSession(
    @Param('sessionId') sessionId: string,
    @Req() req: Request,
  ) {
    await this.ai.restoreSession(sessionId, (req as any).userId);
    return { code: 200, message: '已恢复' };
  }

  @Delete('chat-sessions/:sessionId')
  async deleteSession(
    @Param('sessionId') sessionId: string,
    @Req() req: Request,
  ) {
    await this.ai.deleteSession(sessionId, (req as any).userId);
    return { code: 200, message: '已删除' };
  }

  // ============== 快捷创作 ==============

  @UseGuards(aiRateLimit)
  @Post('quick-create')
  async quickCreate(
    @Body()
    body: {
      premise: string;
      model?: string;
      type?: string;
      guide_summary?: string;
      guide_full_log?: string;
    },
    @Res() res: Response,
    @Req() req: Request,
  ) {
    if (body.type === 'short') {
      await this.ai.quickCreateShort(res, {
        user_id: (req as any).userId,
        premise: body.premise,
        model: body.model,
        guide_summary: body.guide_summary,
        guide_full_log: body.guide_full_log,
      });
    } else {
      await this.ai.quickCreate(res, {
        user_id: (req as any).userId,
        premise: body.premise,
        model: body.model,
        guide_summary: body.guide_summary,
        guide_full_log: body.guide_full_log,
      });
    }
  }

  // ============== AI 生图 ==============

  @UseGuards(aiRateLimit)
  @Post('generate-synopsis')
  async generateSynopsis(
    @Body() body: { book_id: string; model?: string },
    @Req() req: Request,
  ) {
    await this.ai.checkBookOwnership(body.book_id, (req as any).userId);
    const data = await this.ai.generateSynopsis(
      body.book_id,
      (req as any).userId,
      body.model,
    );
    return { code: 200, data };
  }

  @UseGuards(aiRateLimit)
  @Post('recommend-style')
  async recommendStyle(@Body() body: { book_id: string }, @Req() req: Request) {
    await this.ai.checkBookOwnership(body.book_id, (req as any).userId);
    const data = await this.ai.recommendVisualStyle(body.book_id);
    return { code: 200, data };
  }

  @UseGuards(aiRateLimit)
  @Post('generate-cover')
  async generateCover(
    @Body()
    body: {
      book_id: string;
      prompt?: string;
      size?: string;
      style?: string;
      model?: string;
    },
    @Req() req: Request,
  ) {
    await this.ai.checkBookOwnership(body.book_id, (req as any).userId);
    const prompt =
      body.prompt || (await this.ai.buildCoverPrompt(body.book_id));
    const url = await this.ai.generateImage(
      prompt,
      body.size,
      body.style,
      (req as any).userId,
      body.model,
    );

    // 写入 cover_url + 历史
    const db = getDb();
    await db
      .update(schema.books)
      .set({ cover_url: url })
      .where(eq(schema.books.book_id, body.book_id));

    const [settings] = await db
      .select({ extra: schema.book_settings.extra })
      .from(schema.book_settings)
      .where(eq(schema.book_settings.book_id, body.book_id));
    const extra = (settings?.extra ?? {}) as Record<string, any>;
    const history: string[] = extra.cover_history ?? [];
    if (!history.includes(url)) history.push(url);
    await db
      .update(schema.book_settings)
      .set({ extra: { ...extra, cover_history: history } } as any)
      .where(eq(schema.book_settings.book_id, body.book_id));

    return { code: 200, data: { url, history } };
  }

  @UseGuards(aiRateLimit)
  @Post('generate-char-image')
  async generateCharImage(
    @Body()
    body: {
      book_id: string;
      char_id: string;
      prompt?: string;
      size?: string;
      style?: string;
      model?: string;
    },
    @Req() req: Request,
  ) {
    await this.ai.checkBookOwnership(body.book_id, (req as any).userId);
    // 校验角色属于该书
    const db2 = getDb();
    const [charCheck] = await db2
      .select({ book_id: schema.characters.book_id })
      .from(schema.characters)
      .where(eq(schema.characters.char_id, body.char_id))
      .limit(1);
    if (!charCheck || charCheck.book_id !== body.book_id)
      return { code: 403, message: '角色不属于该作品' };

    const prompt = body.prompt || (await this.ai.buildCharPrompt(body.char_id));
    const url = await this.ai.generateImage(
      prompt,
      body.size,
      body.style,
      (req as any).userId,
      body.model,
    );

    // 写入 avatar_url + 历史
    await db2
      .update(schema.characters)
      .set({ avatar_url: url })
      .where(eq(schema.characters.char_id, body.char_id));

    const [char] = await db2
      .select({ avatar_history: schema.characters.avatar_history })
      .from(schema.characters)
      .where(eq(schema.characters.char_id, body.char_id));
    const history: string[] = (char?.avatar_history as any[]) ?? [];
    if (!history.includes(url)) history.push(url);
    await db2
      .update(schema.characters)
      .set({ avatar_history: history } as any)
      .where(eq(schema.characters.char_id, body.char_id));

    return { code: 200, data: { url, history } };
  }
}
