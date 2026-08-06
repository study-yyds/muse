import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Param,
  Query,
  Body,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { BooksService } from './books.service';
import { AuthGuard } from '../auth/auth.guard';
import { BookOwnerGuard } from '../auth/book-owner.guard';

@UseGuards(AuthGuard, BookOwnerGuard)
@Controller('api/books')
export class BooksController {
  constructor(private readonly books: BooksService) {}

  @Get()
  async list(@Query('status') status: string, @Req() req: Request) {
    const userId = (req as any).userId;
    const data = await this.books.list(userId, status);
    return { code: 200, data };
  }

  @Post()
  async create(
    @Body('title') title: string,
    @Body('preset_style') presetStyle: string,
    @Body('type') type: string,
    @Req() req: Request,
  ) {
    const userId = (req as any).userId;
    try {
      const data = await this.books.create(userId, title, presetStyle, type);
      return { code: 201, data };
    } catch (e: any) {
      return { code: 400, message: e.message ?? '创建失败' };
    }
  }

  @Get(':bookId')
  async get(@Param('bookId') bookId: string) {
    const data = await this.books.get(bookId);
    if (!data) return { code: 404, message: '作品不存在' };
    return { code: 200, data };
  }

  @Delete(':bookId')
  async delete(@Param('bookId') bookId: string) {
    await this.books.softDelete(bookId);
    return { code: 200, message: '已删除' };
  }

  @Post(':bookId/restore')
  async restore(@Param('bookId') bookId: string) {
    await this.books.restore(bookId);
    return { code: 200, message: '已恢复' };
  }

  @Patch(':bookId')
  async update(
    @Param('bookId') bookId: string,
    @Body() body: { title?: string; cover_url?: string },
  ) {
    if (body.title) await this.books.updateTitle(bookId, body.title);
    if (body.cover_url) await this.books.updateCover(bookId, body.cover_url);
    return { code: 200, message: '已更新' };
  }

  @Get(':bookId/settings')
  async getSettings(@Param('bookId') bookId: string) {
    const book = await this.books.get(bookId);
    if (!book) return { code: 404, message: '作品不存在' };
    return {
      code: 200,
      data: {
        preset_style: book.preset_style,
        auto_save_interval_sec: book.auto_save_interval_sec,
        extra: book.extra,
      },
    };
  }

  @Put(':bookId/settings')
  async updateSettings(
    @Param('bookId') bookId: string,
    @Body()
    body: {
      preset_style?: string;
      auto_save_interval_sec?: number;
      daily_word_goal?: number;
      extra?: Record<string, any>;
    },
  ) {
    await this.books.updateSettings(bookId, body);
    return { code: 200, message: '设置已保存' };
  }
}
