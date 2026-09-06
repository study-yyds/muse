import { Injectable } from '@nestjs/common';
import { eq, and, asc, sql } from 'drizzle-orm';
import { getDb, schema } from '../database/connection';

/** 服务器本地日期键（YYYY-MM-DD），避免 UTC 切日错位 8 小时 */
function localDayKey(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 统一字数口径：中文按字、英文/数字按词，标点/空白不计。
 * 服务端重算，不信任客户端上报的 word_count
 */
export function countWords(content: string): number {
  if (!content) return 0;
  const cjk = (content.match(/[一-鿿㐀-䶿぀-ヿ]/g) ?? []).length;
  const latin = (
    content.replace(/[一-鿿㐀-䶿぀-ヿ]/g, ' ').match(/[a-zA-Z0-9]+/g) ?? []
  ).length;
  return cjk + latin;
}

@Injectable()
export class ChaptersService {
  async list(bookId: string) {
    const db = getDb();
    return db
      .select({
        chapter_id: schema.chapters.chapter_id,
        title: schema.chapters.title,
        sort_order: schema.chapters.sort_order,
        word_count: schema.chapters.word_count,
        bound_outline_node_id: schema.chapters.bound_outline_node_id,
        updated_at: schema.chapters.updated_at,
      })
      .from(schema.chapters)
      .where(eq(schema.chapters.book_id, bookId))
      .orderBy(asc(schema.chapters.sort_order));
  }

  async get(chapterId: string, bookId?: string) {
    const db = getDb();
    const [ch] = await db
      .select()
      .from(schema.chapters)
      .where(eq(schema.chapters.chapter_id, chapterId))
      .limit(1);
    if (bookId && ch && ch.book_id !== bookId) return null;
    return ch ?? null;
  }

  async create(bookId: string, title: string) {
    const db = getDb();
    // 获取当前最大 sort_order
    const [last] = await db
      .select({
        max: sql<number>`coalesce(max(${schema.chapters.sort_order}), 0)`,
      })
      .from(schema.chapters)
      .where(eq(schema.chapters.book_id, bookId));
    const sortOrder = (last?.max ?? 0) + 1;

    // 自动绑定：章纲生成时保存的行→节点映射（快捷生成作品免手动绑定）
    let boundNode: string | null = null;
    try {
      const [settings] = await db
        .select({ extra: schema.book_settings.extra })
        .from(schema.book_settings)
        .where(eq(schema.book_settings.book_id, bookId))
        .limit(1);
      const binding = ((settings?.extra ?? {}) as Record<string, any>)
        ?.chapter_node_binding as Record<string, string> | undefined;
      boundNode = binding?.[String(sortOrder)] ?? null;
    } catch {
      /* 绑定查询失败不阻断建章 */
    }

    const [ch] = await db
      .insert(schema.chapters)
      .values({
        book_id: bookId,
        title,
        sort_order: sortOrder,
        ...(boundNode ? { bound_outline_node_id: boundNode } : {}),
      })
      .returning();
    return ch;
  }

  async save(
    chapterId: string,
    content: string,
    wordCount: number,
    boundOutlineNodeId?: string | null,
    expectedBookId?: string,
  ) {
    const db = getDb();
    // 校验章节属于该书 + 读取旧内容用于计算字数增量
    let oldContent = '';
    if (expectedBookId) {
      const [ch] = await db
        .select({
          book_id: schema.chapters.book_id,
          content: schema.chapters.content,
        })
        .from(schema.chapters)
        .where(eq(schema.chapters.chapter_id, chapterId))
        .limit(1);
      if (!ch || ch.book_id !== expectedBookId)
        throw new Error('章节不属于该作品');
      oldContent = ch.content ?? '';
    }
    const data: any = {
      content,
      // 服务端按统一口径重算字数（中文按字/英文按词），不信任客户端上报
      word_count: countWords(content),
      updated_at: sql`NOW()`,
    };
    if (boundOutlineNodeId !== undefined) {
      data.bound_outline_node_id = boundOutlineNodeId || null;
    }
    await db
      .update(schema.chapters)
      .set(data)
      .where(eq(schema.chapters.chapter_id, chapterId));

    if (expectedBookId) {
      // 同步更新作品总字数
      await this.#recalcBookWords(expectedBookId);

      // 字数增量记入每日日志（只记增长，删除/削减不计负值）
      const delta = countWords(content) - countWords(oldContent);
      if (delta > 0) await this.#recordDailyWords(expectedBookId, delta);

      // 状态流转：有正文内容时触发
      if (content?.trim()) {
        // 绑定的大纲节点 planned → writing
        if (boundOutlineNodeId) {
          await db
            .update(schema.outline_chapters)
            .set({ status: 'writing', updated_at: sql`NOW()` })
            .where(
              and(
                eq(schema.outline_chapters.id, boundOutlineNodeId),
                eq(schema.outline_chapters.status, 'planned'),
              ),
            );
        }
        // 作品 draft → writing
        await db
          .update(schema.books)
          .set({ status: 'writing' })
          .where(
            and(
              eq(schema.books.book_id, expectedBookId),
              eq(schema.books.status, 'draft'),
            ),
          );
      }
    }
  }

  /**
   * 每日字数增量日志：写入 book_settings.extra.daily_word_log，
   * 只保留最近 90 天。统计基于增量，后续编辑其他章节不会重写历史。
   */
  async #recordDailyWords(bookId: string, delta: number) {
    if (delta <= 0) return;
    const db = getDb();
    const [settings] = await db
      .select({ extra: schema.book_settings.extra })
      .from(schema.book_settings)
      .where(eq(schema.book_settings.book_id, bookId))
      .limit(1);
    const extra = (settings?.extra ?? {}) as Record<string, any>;
    const log = (extra.daily_word_log ?? {}) as Record<string, number>;
    const cutoff = localDayKey(new Date(Date.now() - 90 * 24 * 60 * 60 * 1000));
    const pruned: Record<string, number> = {};
    for (const [k, v] of Object.entries(log)) {
      if (k >= cutoff) pruned[k] = v;
    }
    const day = localDayKey();
    pruned[day] = (pruned[day] ?? 0) + delta;
    await db
      .update(schema.book_settings)
      .set({ extra: { ...extra, daily_word_log: pruned } })
      .where(eq(schema.book_settings.book_id, bookId));
  }

  async delete(chapterId: string, bookId?: string) {
    const db = getDb();
    const [ch] = await db
      .select({ book_id: schema.chapters.book_id })
      .from(schema.chapters)
      .where(eq(schema.chapters.chapter_id, chapterId))
      .limit(1);
    if (bookId && ch && ch.book_id !== bookId) {
      throw new Error('章节不属于该作品');
    }
    await db
      .delete(schema.chapters)
      .where(eq(schema.chapters.chapter_id, chapterId));
    if (ch) {
      // 绑定该章节的大纲节点回退为规划中（单向绑定：章节→节点）
      await db
        .update(schema.outline_chapters)
        .set({
          status: 'planned',
          bound_chapter_id: null,
          updated_at: sql`NOW()`,
        })
        .where(eq(schema.outline_chapters.bound_chapter_id, chapterId));
      await this.#recalcBookWords(ch.book_id);
    }
  }

  // 重算作品总字数
  async #recalcBookWords(bookId: string) {
    const db = getDb();
    const [row] = await db
      .select({
        total: sql<number>`COALESCE(SUM(${schema.chapters.word_count}), 0)`,
      })
      .from(schema.chapters)
      .where(eq(schema.chapters.book_id, bookId));
    await db
      .update(schema.books)
      .set({ word_count: row?.total ?? 0, updated_at: sql`NOW()` })
      .where(eq(schema.books.book_id, bookId));
  }
}
