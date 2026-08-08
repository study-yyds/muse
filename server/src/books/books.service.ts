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
        type: schema.books.type,
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
  async create(userId: string, title: string, presetStyle?: string, type?: string) {
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
      .values({ user_id: userId, title, type: type || 'novel' } as any)
      .returning({ book_id: schema.books.book_id });

    // 创建关联的 settings 和 outline
    await db
      .insert(schema.book_settings)
      .values({
        book_id: book.book_id,
        preset_style: presetStyle ?? 'default',
      });
    await db.insert(schema.outlines).values({ book_id: book.book_id });

    // 短篇自动创建唯一章节
    if (type === 'short') {
      await db.insert(schema.chapters).values({
        book_id: book.book_id,
        title: '正文',
        sort_order: 1,
      });
    }

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
        type: schema.books.type,
        last_updated: schema.books.updated_at,
        preset_style: schema.book_settings.preset_style,
        auto_save_interval_sec: schema.book_settings.auto_save_interval_sec,
        extra: schema.book_settings.extra,
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

  // 更新标题
  async updateTitle(bookId: string, title: string) {
    const db = getDb();
    await db
      .update(schema.books)
      .set({ title, updated_at: sql`NOW()` })
      .where(eq(schema.books.book_id, bookId));
  }

  // 更新封面
  async updateCover(bookId: string, coverUrl: string) {
    const db = getDb();
    await db
      .update(schema.books)
      .set({ cover_url: coverUrl, updated_at: sql`NOW()` })
      .where(eq(schema.books.book_id, bookId));
  }

  // 软删除
  async softDelete(bookId: string) {
    const db = getDb();
    await db
      .update(schema.books)
      .set({ deleted_at: sql`NOW()` })
      .where(eq(schema.books.book_id, bookId));
  }

  // 永久删除
  async permanentDelete(bookId: string) {
    const db = getDb();
    await db.delete(schema.books).where(eq(schema.books.book_id, bookId));
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
      extra?: Record<string, any>;
    },
  ) {
    const db = getDb();
    // 构建更新对象，extra 需要合并而非覆盖
    const updateData: any = { updated_at: sql`NOW()` };
    if (data.preset_style !== undefined) updateData.preset_style = data.preset_style;
    if (data.auto_save_interval_sec !== undefined) updateData.auto_save_interval_sec = data.auto_save_interval_sec;
    if (data.extra) {
      // 先取当前 extra，合并后再写入
      const [settings] = await db
        .select({ extra: schema.book_settings.extra })
        .from(schema.book_settings)
        .where(eq(schema.book_settings.book_id, bookId));
      const currentExtra = (settings?.extra ?? {}) as Record<string, any>;
      updateData.extra = { ...currentExtra, ...data.extra };
    }
    if (data.daily_word_goal !== undefined) {
      if (!updateData.extra) {
        const [settings] = await db
          .select({ extra: schema.book_settings.extra })
          .from(schema.book_settings)
          .where(eq(schema.book_settings.book_id, bookId));
        updateData.extra = { ...((settings?.extra ?? {}) as Record<string, any>), daily_word_goal: data.daily_word_goal };
      } else {
        updateData.extra.daily_word_goal = data.daily_word_goal;
      }
    }
    await db
      .update(schema.book_settings)
      .set(updateData)
      .where(eq(schema.book_settings.book_id, bookId));
  }
}
