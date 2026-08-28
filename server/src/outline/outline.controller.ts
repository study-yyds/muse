import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  UseGuards,
} from '@nestjs/common';
import { OutlineService } from './outline.service';
import { AuthGuard } from '../auth/auth.guard';
import { BookOwnerGuard } from '../auth/book-owner.guard';

@UseGuards(AuthGuard, BookOwnerGuard)
@Controller('api/books/:bookId/outline')
export class OutlineController {
  constructor(private readonly outline: OutlineService) {}

  @Get()
  async get(@Param('bookId') bookId: string) {
    const data = await this.outline.get(bookId);
    return { code: 200, data };
  }

  @Post('chapters')
  async addChapter(
    @Param('bookId') bookId: string,
    @Body() body: { title: string; summary: string; act_name?: string },
  ) {
    const data = await this.outline.addChapter(
      bookId,
      body.title,
      body.summary,
      body.act_name,
    );
    return { code: 201, data };
  }

  @Patch('chapters/:chapterId')
  async updateChapter(
    @Param('bookId') bookId: string,
    @Param('chapterId') chapterId: string,
    @Body() body: { title?: string; summary?: string; status?: string },
  ) {
    await this.outline.updateChapter(chapterId, body, bookId);
    return { code: 200, message: '已更新' };
  }

  @Delete('chapters/:chapterId')
  async deleteChapter(
    @Param('bookId') bookId: string,
    @Param('chapterId') chapterId: string,
  ) {
    await this.outline.deleteChapter(chapterId, bookId);
    return { code: 200, message: '已删除' };
  }

  // 注：绑定只保留单向（章节侧 bound_outline_node_id），
  // 大纲节点侧 bind 接口已移除，避免双向同步负担
}
