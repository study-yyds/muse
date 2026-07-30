import { Injectable } from '@nestjs/common';
import { eq, and, isNull, desc, sql } from 'drizzle-orm';
import { getDb, schema } from '../database/connection';

@Injectable()
export class BooksService {
  // 获取用户作品列表
  async list(userId: string, status?: string) {
    const db = getDb();
    const isDeleted = status === 'deleted';

    const rows = await db
      .select({
        book_id: schema.books.book_id,
        title: schema.books.title,
        cover_url: schema.books.cover_url,
        word_count: schema.books.word_count,
        status: schema.books.status,
        last_updated: schema.books.updated_at,
      })
      .from(schema.books)
      .where(
        and(
          eq(schema.books.user_id, userId),
          isDeleted
            ? sql`${schema.books.deleted_at} IS NOT NULL`
            : isNull(schema.books.deleted_at),
        ),
      )
      .orderBy(desc(schema.books.updated_at));

    return rows;
  }

  // 创建作品
  async create(userId: string, title: string, presetStyle?: string) {
    const db = getDb();

    // 检查配额
    const [count] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.books)
      .where(
        and(eq(schema.books.user_id, userId), isNull(schema.books.deleted_at)),
      );

    const [user] = await db
      .select({ book_limit: schema.users.book_limit })
      .from(schema.users)
      .where(eq(schema.users.user_id, userId));

    if (user && count.count >= user.book_limit) {
      throw new Error('已达到免费作品数上限');
    }

    const [book] = await db
      .insert(schema.books)
      .values({ user_id: userId, title })
      .returning({ book_id: schema.books.book_id });

    // 创建关联的 settings 和 outline
    await db
      .insert(schema.book_settings)
      .values({
        book_id: book.book_id,
        preset_style: presetStyle ?? 'default',
      });
    await db.insert(schema.outlines).values({ book_id: book.book_id });

    return book;
  }

  // 获取作品详情
  async get(bookId: string) {
    const db = getDb();
    const [book] = await db
      .select({
        book_id: schema.books.book_id,
        title: schema.books.title,
        cover_url: schema.books.cover_url,
        word_count: schema.books.word_count,
        status: schema.books.status,
        last_updated: schema.books.updated_at,
        preset_style: schema.book_settings.preset_style,
        auto_save_interval_sec: schema.book_settings.auto_save_interval_sec,
      })
      .from(schema.books)
      .leftJoin(
        schema.book_settings,
        eq(schema.book_settings.book_id, schema.books.book_id),
      )
      .where(eq(schema.books.book_id, bookId))
      .limit(1);

    return book ?? null;
  }

  // 软删除
  async softDelete(bookId: string) {
    const db = getDb();
    await db
      .update(schema.books)
      .set({ deleted_at: sql`NOW()` })
      .where(eq(schema.books.book_id, bookId));
  }

  // 恢复
  async restore(bookId: string) {
    const db = getDb();
    await db
      .update(schema.books)
      .set({ deleted_at: null })
      .where(
        and(
          eq(schema.books.book_id, bookId),
          sql`${schema.books.deleted_at} IS NOT NULL`,
          sql`${schema.books.deleted_at} > NOW() - INTERVAL '7 days'`,
        ),
      );
  }

  // 更新设置
  async updateSettings(
    bookId: string,
    data: {
      preset_style?: string;
      auto_save_interval_sec?: number;
      daily_word_goal?: number;
    },
  ) {
    const db = getDb();
    await db
      .update(schema.book_settings)
      .set({
        ...(data.preset_style ? { preset_style: data.preset_style } : {}),
        ...(data.auto_save_interval_sec
          ? { auto_save_interval_sec: data.auto_save_interval_sec }
          : {}),
        ...(data.daily_word_goal !== undefined
          ? { extra: { daily_word_goal: data.daily_word_goal } }
          : {}),
        updated_at: sql`NOW()`,
      })
      .where(eq(schema.book_settings.book_id, bookId));
  }
}
