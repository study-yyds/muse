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
  BadRequestException,
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
  @Post('chat')
  async chat(
    @Body()
    body: {
      book_id?: string;
      context_type: string;
      message: string;
      messages?: any[];
      model?: string;
      key_id?: string;
      chapter_id?: string;
      cursor_position?: number;
      style?: string;
      rewrite?: boolean;
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
  @Post('chapter-outlines/extend')
  async extendChapterOutlines(
    @Body()
    body: {
      book_id: string;
      model?: string;
      key_id?: string;
      count?: number;
      node_id?: string;
    },
    @Req() req: Request,
  ) {
    await this.ai.checkBookOwnership(body.book_id, (req as any).userId);
    const data = await this.ai.extendChapterOutlines(
      (req as any).userId,
      body.book_id,
      body.model,
      body.key_id,
      body.count,
      body.node_id,
    );
    return { code: 200, data };
  }

  @Get('quota')
  async quota(@Req() req: Request) {
    const data = await this.ai.getMonthlyQuota((req as any).userId);
    return { code: 200, data };
  }

  @UseGuards(aiRateLimit)
  @Post('outline-nodes/refine')
  async refineNode(
    @Body()
    body: {
      book_id: string;
      node_id: string;
      model?: string;
      key_id?: string;
    },
    @Req() req: Request,
  ) {
    try {
      await this.ai.checkBookOwnership(body.book_id, (req as any).userId);
      const data = await this.ai.refineNode(
        (req as any).userId,
        body.book_id,
        body.node_id,
        body.model,
        body.key_id,
      );
      return { code: 200, data };
    } catch (e: any) {
      // 显式返回真实错误信息：前端 toast 直接展示（定位 500 原因不用翻终端日志）
      console.error('[refine-node] error:', e?.message ?? e);
      return { code: 500, message: e?.message ?? '节点细化失败，请重试' };
    }
  }


  @UseGuards(aiRateLimit)
  @Post('generate-chapter')
  async generateChapter(
    @Body()
    body: {
      book_id: string;
      chapter_id: string;
      model?: string;
      key_id?: string;
      style?: string;
      replace?: boolean;
    },
    @Res() res: Response,
    @Req() req: Request,
  ) {
    await this.ai.checkBookOwnership(body.book_id, (req as any).userId);
    await this.ai.generateChapter(res, {
      ...body,
      user_id: (req as any).userId,
    });
  }

  @UseGuards(aiRateLimit)
  @Post('mimic-style')
  async mimicStyle(
    @Body()
    body: { book_id?: string; model?: string; key_id?: string; text?: string },
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
      body.key_id,
    );
    return { code: 200, data };
  }

  // ============== TTS 语音合成 ==============

  @UseGuards(aiRateLimit)
  @Post('generate-speech')
  async generateSpeech(
    @Body()
    body: {
      text: string;
      voice_type?: string;
    },
    @Req() req: Request,
  ) {
    try {
      const url = await this.ai.generateSpeech(
        body.text,
        body.voice_type,
        (req as any).userId,
      );
      return { code: 200, data: { url } };
    } catch (e: any) {
      return { code: 500, message: e.message ?? 'TTS 失败' };
    }
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
      key_id?: string;
      type?: string;
      guide_summary?: string;
      guide_full_log?: string;
      // 自写梗概模式：骨架化已在客户端确认，后端只建书 + 写 settings
      mode?: string;
      synopsis?: string;
      skeleton?: string;
      preview?: string;
    },
    @Res() res: Response,
    @Req() req: Request,
  ) {
    if (body.type === 'short' && body.mode === 'synopsis') {
      const data = await this.ai.createShortFromSynopsis({
        user_id: (req as any).userId,
        synopsis: body.synopsis || body.premise,
        skeleton: body.skeleton,
        preview: body.preview,
      });
      res.status(200).json({ code: 200, data });
      return;
    }
    if (body.type === 'short') {
      await this.ai.quickCreateShort(res, {
        user_id: (req as any).userId,
        premise: body.premise,
        model: body.model,
        key_id: body.key_id,
        guide_summary: body.guide_summary,
        guide_full_log: body.guide_full_log,
      });
    } else {
      await this.ai.quickCreate(res, {
        user_id: (req as any).userId,
        premise: body.premise,
        model: body.model,
        key_id: body.key_id,
        guide_summary: body.guide_summary,
        guide_full_log: body.guide_full_log,
      });
    }
  }

  // 自写梗概：骨架化 + 逻辑体检（一次调用，返回骨架/梗概/风险列表）
  @UseGuards(aiRateLimit)
  @Post('skeletonize')
  async skeletonizeSynopsis(
    @Body()
    body: {
      synopsis: string;
      model?: string;
      key_id?: string;
      with_check?: boolean;
    },
    @Req() req: Request,
  ) {
    if (!body.synopsis?.trim()) {
      throw new BadRequestException('缺少故事梗概');
    }
    const data = await this.ai.skeletonizeSynopsis({
      user_id: (req as any).userId,
      synopsis: body.synopsis,
      model: body.model,
      key_id: body.key_id,
      with_check: body.with_check !== false,
    });
    return { code: 200, data };
  }

  // ============== AI 生图 ==============

  @UseGuards(aiRateLimit)
  @Post('generate-story')
  async generateStory(
    @Body()
    body: {
      book_id: string;
      premise: string;
      model?: string;
      key_id?: string;
      resume_story?: boolean;
    },
    @Res() res: Response,
    @Req() req: Request,
  ) {
    if (!body.book_id) {
      throw new BadRequestException('缺少 book_id');
    }
    await this.ai.checkBookOwnership(body.book_id, (req as any).userId);
    await this.ai.generateStory(res, {
      user_id: (req as any).userId,
      book_id: body.book_id,
      premise: body.premise || '',
      model: body.model,
      key_id: body.key_id,
      resume_story: body.resume_story,
    });
  }

  @UseGuards(aiRateLimit)
  @Post('zhihu-pack')
  async zhihuPack(
    @Body() body: { book_id: string; content: string },
    @Req() req: Request,
  ) {
    if (!body.content?.trim()) {
      throw new BadRequestException('缺少章节内容');
    }
    await this.ai.checkBookOwnership(body.book_id, (req as any).userId);
    const data = await this.ai.generateZhihuPack(
      body.content,
      (req as any).userId,
      body.book_id,
    );
    return { code: 200, data };
  }

  @UseGuards(aiRateLimit)
  @Post('generate-synopsis')
  async generateSynopsis(
    @Body() body: { book_id: string; model?: string; key_id?: string },
    @Req() req: Request,
  ) {
    await this.ai.checkBookOwnership(body.book_id, (req as any).userId);
    const data = await this.ai.generateSynopsis(
      body.book_id,
      (req as any).userId,
      body.model,
      body.key_id,
    );
    return { code: 200, data };
  }

  @UseGuards(aiRateLimit)
  @Post('recommend-style')
  async recommendStyle(@Body() body: { book_id: string }, @Req() req: Request) {
    await this.ai.checkBookOwnership(body.book_id, (req as any).userId);
    const data = await this.ai.recommendVisualStyle(
      body.book_id,
      (req as any).userId,
    );
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
      key_id?: string;
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
      body.key_id,
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
    // 截断历史版本，防止 JSONB 无限膨胀
    const cappedHistory = history.slice(-20);
    await db
      .update(schema.book_settings)
      .set({ extra: { ...extra, cover_history: cappedHistory } } as any)
      .where(eq(schema.book_settings.book_id, body.book_id));

    return { code: 200, data: { url, history: cappedHistory } };
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
      key_id?: string;
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
      body.key_id,
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
    // 截断历史版本，防止 JSONB 无限膨胀
    const cappedHistory = history.slice(-20);
    await db2
      .update(schema.characters)
      .set({ avatar_history: cappedHistory } as any)
      .where(eq(schema.characters.char_id, body.char_id));

    return { code: 200, data: { url, history: cappedHistory } };
  }
}
