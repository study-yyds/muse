import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../database/connection';
import { AuthGuard } from '../auth/auth.guard';
import { BookOwnerGuard } from '../auth/book-owner.guard';

/** 服务器本地日期键（YYYY-MM-DD），避免 UTC 切日错位 8 小时 */
function localDayKey(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

@UseGuards(AuthGuard, BookOwnerGuard)
@Controller('api/books/:bookId/stats')
export class BooksStatsController {
  @Get()
  async getStats(@Param('bookId') bookId: string) {
    const db = getDb();
    // 两个查询并行：此前顺序执行，叠加跨洋往返让统计 tab 加载明显变慢
    const [chapters, [settings]] = await Promise.all([
      db
        .select({
          word_count: schema.chapters.word_count,
          updated_at: schema.chapters.updated_at,
        })
        .from(schema.chapters)
        .where(eq(schema.chapters.book_id, bookId)),
      db
        .select({ extra: schema.book_settings.extra })
        .from(schema.book_settings)
        .where(eq(schema.book_settings.book_id, bookId))
        .limit(1),
    ]);

    const total = chapters.reduce((sum, c) => sum + (c.word_count ?? 0), 0);
    const chapterCount = chapters.length;

    // 每日字数：优先用增量日志（保存时记录，编辑旧章节不会重写历史）。
    // 无日志的作品（升级前写的）回退到旧逻辑（按章节最后更新日全量归属）
    const log = ((settings?.extra ?? {}) as Record<string, any>)
      ?.daily_word_log as Record<string, number> | undefined;

    let daily: Record<string, number>;
    if (log && Object.keys(log).length > 0) {
      daily = { ...log };
    } else {
      daily = {};
      for (const c of chapters) {
        if (!c.updated_at) continue;
        const day = localDayKey(new Date(c.updated_at));
        daily[day] = (daily[day] ?? 0) + (c.word_count ?? 0);
      }
    }

    // 今日字数
    const today = localDayKey();
    const todayWords = daily[today] ?? 0;

    // 连续打卡天数：从今天（今天未写则从昨天）往前数
    let streak = 0;
    const cursor = new Date();
    if (!(daily[today] ?? 0) && (daily[localDayKey(yesterday())] ?? 0)) {
      cursor.setDate(cursor.getDate() - 1);
    }
    while (true) {
      const key = localDayKey(cursor);
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

function yesterday(): Date {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d;
}
