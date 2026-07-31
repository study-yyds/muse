import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { getDb, schema } from '../database/connection';
import { AuthGuard } from '../auth/auth.guard';

@UseGuards(AuthGuard)
@Controller('api/books/:bookId/stats')
export class BooksStatsController {
  @Get()
  async getStats(@Param('bookId') bookId: string) {
    const db = getDb();
    const chapters = await db
      .select({
        word_count: schema.chapters.word_count,
        updated_at: schema.chapters.updated_at,
      })
      .from(schema.chapters)
      .where(eq(schema.chapters.book_id, bookId));

    const total = chapters.reduce((sum, c) => sum + (c.word_count ?? 0), 0);
    const chapterCount = chapters.length;

    // 按日期聚合字数
    const daily: Record<string, number> = {};
    for (const c of chapters) {
      if (!c.updated_at) continue;
      const day = new Date(c.updated_at).toISOString().slice(0, 10);
      daily[day] = (daily[day] ?? 0) + (c.word_count ?? 0);
    }

    // 今日字数
    const today = new Date().toISOString().slice(0, 10);
    const todayWords = daily[today] ?? 0;

    // 连续打卡天数（从今天往前数）
    let streak = 0;
    const cursor = new Date();
    while (true) {
      const key = cursor.toISOString().slice(0, 10);
      if (daily[key] && daily[key] > 0) {
        streak++;
        cursor.setDate(cursor.getDate() - 1);
      } else {
        break;
      }
    }

    return {
      code: 200,
      data: { total, chapterCount, daily, todayWords, streak },
    };
  }
}
