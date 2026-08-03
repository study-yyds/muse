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

const aiRateLimit = new RateLimitGuard(10, 60_000); // 每分钟10次

@UseGuards(AuthGuard, aiRateLimit)
@Controller('api/ai')
export class AiController {
  constructor(private readonly ai: AiService) {}

  @Post('generate')
  async generate(@Body() body: any, @Res() res: Response, @Req() req: Request) {
    body.user_id = (req as any).userId;
    await this.ai.generate(res, body);
  }

  @Post('extract-settings')
  async extractSettings(
    @Body() body: { book_id: string; chapter_id: string; model: string },
    @Req() req: Request,
  ) {
    await this.ai.checkBookOwnership(body.book_id, (req as any).userId);
    const data = await this.ai.extractSettings(body.book_id, body.chapter_id, body.model);
    return { code: 200, data };
  }

  @Post('chat')
  async chat(
    @Body()
    body: {
      book_id: string;
      context_type: string;
      message: string;
      messages?: any[];
      model?: string;
      chapter_id?: string;
      cursor_position?: number;
      style?: string;
    },
    @Res() res: Response,
    @Req() req: Request,
  ) {
    await this.ai.chat(res, { ...body, user_id: (req as any).userId });
  }

  @Post('mimic-style')
  async mimicStyle(
    @Body() body: { book_id?: string; model?: string; text?: string },
    @Req() req: Request,
  ) {
    if (body.book_id) {
      await this.ai.checkBookOwnership(body.book_id, (req as any).userId);
    }
    const data = await this.ai.mimicStyle(body.book_id, body.model ?? 'deepseek-v4-flash', body.text);
    return { code: 200, data };
  }

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
    await this.ai.checkBookOwnership(bookId, userId);
    if (!section) {
      // 没有 section 参数时返回活跃会话
      return { code: 200, data: null };
    }
    const active = await this.ai.getActiveSession(bookId, section);
    const all = await this.ai.getSessions(bookId, section);
    return { code: 200, data: { active, sessions: all } };
  }

  @Post('chat-sessions')
  async createSession(
    @Body()
    body: {
      book_id: string;
      section: string;
      title?: string;
    },
    @Req() req: Request,
  ) {
    const data = await this.ai.createSession(
      body.book_id,
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
}
