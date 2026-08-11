import { Controller, Post, Get, Param, Body, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { CharTestService } from './char-test.service';
import { AuthGuard } from '../auth/auth.guard';
import { BookOwnerGuard } from '../auth/book-owner.guard';

@UseGuards(AuthGuard, BookOwnerGuard)
@Controller('api/books/:bookId/characters/:charId/test')
export class CharTestController {
  constructor(private readonly service: CharTestService) {}

  // 获取或创建测试会话
  @Post()
  async getOrCreateSession(@Param('bookId') bookId: string, @Param('charId') charId: string) {
    const session = await this.service.getOrCreateSession(charId, bookId);
    return { code: 200, data: session };
  }

  // 列出角色的测试会话
  @Get()
  async listSessions(@Param('bookId') bookId: string, @Param('charId') charId: string) {
    const sessions = await this.service.listSessions(charId, bookId);
    return { code: 200, data: sessions };
  }

  // 发送消息进行对话（SSE 流式）
  @Post(':sessionId/message')
  async chat(
    @Param('bookId') bookId: string,
    @Param('charId') charId: string,
    @Param('sessionId') sessionId: string,
    @Body() body: { message: string; model?: string; api_key?: string; base_url?: string },
    @Res() res: Response,
  ) {
    await this.service.chat(res, charId, sessionId, body.message, body.model, body.api_key, body.base_url, bookId);
  }
}
