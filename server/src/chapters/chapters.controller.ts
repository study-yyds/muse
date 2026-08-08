import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  UseGuards,
} from '@nestjs/common';
import { ChaptersService } from './chapters.service';
import { AuthGuard } from '../auth/auth.guard';
import { BookOwnerGuard } from '../auth/book-owner.guard';

@UseGuards(AuthGuard, BookOwnerGuard)
@Controller('api/books/:bookId/chapters')
export class ChaptersController {
  constructor(private readonly ch: ChaptersService) {}

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
  async get(@Param('chapterId') chapterId: string) {
    const data = await this.ch.get(chapterId);
    if (!data) return { code: 404, message: '章节不存在' };
    return { code: 200, data };
  }

  @Put(':chapterId')
  async save(
    @Param('bookId') bookId: string,
    @Param('chapterId') chapterId: string,
    @Body() body: { content: string; word_count: number; bound_outline_node_id?: string | null },
  ) {
    try {
      await this.ch.save(chapterId, body.content, body.word_count, body.bound_outline_node_id, bookId);
      return { code: 200, message: '已保存' };
    } catch (e: any) {
      return { code: 403, message: e.message };
    }
  }

  @Delete(':chapterId')
  async delete(@Param('chapterId') chapterId: string) {
    await this.ch.delete(chapterId);
    return { code: 200, message: '已删除' };
  }

}
