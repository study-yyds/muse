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

@UseGuards(AuthGuard)
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
    @Body() body: { title: string; summary: string },
  ) {
    const data = await this.outline.addChapter(
      bookId,
      body.title,
      body.summary,
    );
    return { code: 201, data };
  }

  @Patch('chapters/:chapterId')
  async updateChapter(
    @Param('chapterId') chapterId: string,
    @Body() body: { title?: string; summary?: string },
  ) {
    await this.outline.updateChapter(chapterId, body);
    return { code: 200, message: '已更新' };
  }

  @Delete('chapters/:chapterId')
  async deleteChapter(@Param('chapterId') chapterId: string) {
    await this.outline.deleteChapter(chapterId);
    return { code: 200, message: '已删除' };
  }

  @Patch('chapters/:chapterId/bind')
  async bind(
    @Param('chapterId') chapterId: string,
    @Body('bound_chapter_id') boundChapterId: string | null,
  ) {
    await this.outline.bind(chapterId, boundChapterId);
    return { code: 200, message: '已绑定' };
  }
}
