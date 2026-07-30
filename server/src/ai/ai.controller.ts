import { Controller, Post, Body, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { AiService } from './ai.service';
import { AuthGuard } from '../auth/auth.guard';

@UseGuards(AuthGuard)
@Controller('api/ai')
export class AiController {
  constructor(private readonly ai: AiService) {}

  @Post('generate')
  async generate(@Body() body: any, @Res() res: Response) {
    await this.ai.generate(res, body);
  }

  @Post('extract-settings')
  async extractSettings(
    @Body() body: { book_id: string; chapter_id: string; model: string },
  ) {
    const data = await this.ai.extractSettings(
      body.book_id,
      body.chapter_id,
      body.model,
    );
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
  ) {
    await this.ai.chat(res, body);
  }

  @Post('mimic-style')
  async mimicStyle(
    @Body() body: { book_id?: string; model?: string; text?: string },
  ) {
    const data = await this.ai.mimicStyle(body.book_id, body.model ?? 'deepseek-v4-flash', body.text);
    return { code: 200, data };
  }
}
