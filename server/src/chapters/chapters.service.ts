import { Injectable } from '@nestjs/common';
import { eq, and, asc, desc, sql } from 'drizzle-orm';
import { getDb, schema } from '../database/connection';

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
        updated_at: schema.chapters.updated_at,
      })
      .from(schema.chapters)
      .where(eq(schema.chapters.book_id, bookId))
      .orderBy(asc(schema.chapters.sort_order));
  }

  async get(chapterId: string) {
    const db = getDb();
    const [ch] = await db
      .select()
      .from(schema.chapters)
      .where(eq(schema.chapters.chapter_id, chapterId))
      .limit(1);
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

    const [ch] = await db
      .insert(schema.chapters)
      .values({ book_id: bookId, title, sort_order: (last?.max ?? 0) + 1 })
      .returning();
    return ch;
  }

  async save(chapterId: string, content: string, wordCount: number) {
    const db = getDb();
    await db
      .update(schema.chapters)
      .set({ content, word_count: wordCount, updated_at: sql`NOW()` })
      .where(eq(schema.chapters.chapter_id, chapterId));
  }

  async delete(chapterId: string) {
    const db = getDb();
    await db
      .delete(schema.chapters)
      .where(eq(schema.chapters.chapter_id, chapterId));
  }

  // 合并两章：拼接内容，删旧建新
  async merge(bookId: string, ids: string[], newTitle: string) {
    const db = getDb();
    const chapters = await db
      .select()
      .from(schema.chapters)
      .where(eq(schema.chapters.book_id, bookId))
      .orderBy(asc(schema.chapters.sort_order));
    const toMerge = chapters.filter((c) => ids.includes(c.chapter_id));
    if (toMerge.length < 2) throw new Error('至少需要两章');

    const mergedContent = toMerge.map((c) => c.content).join('\n\n---\n\n');
    const mergedWords = toMerge.reduce((s, c) => s + c.word_count, 0);
    const targetOrder = Math.min(...toMerge.map((c) => c.sort_order));

    // 删旧（事务中先删，再插入）
    for (const c of toMerge)
      await db
        .delete(schema.chapters)
        .where(eq(schema.chapters.chapter_id, c.chapter_id));

    // 插入合并后的新章
    const [ch] = await db
      .insert(schema.chapters)
      .values({
        book_id: bookId,
        title: newTitle,
        content: mergedContent,
        word_count: mergedWords,
        sort_order: targetOrder,
      })
      .returning();
    return ch;
  }

  // 拆分一章为两章：在 splitAt 位置切分
  async split(bookId: string, chapterId: string, splitAt: number) {
    const db = getDb();
    const [ch] = await db
      .select()
      .from(schema.chapters)
      .where(eq(schema.chapters.chapter_id, chapterId))
      .limit(1);
    if (!ch) throw new Error('章节不存在');

    const part1 = ch.content.slice(0, splitAt);
    const part2 = ch.content.slice(splitAt);

    // 给后续章节让位（DESC 排序避免 UNIQUE 约束冲突）
    await getDb().execute(
      sql`UPDATE chapters SET sort_order = sort_order + 1 WHERE book_id = ${bookId}::uuid AND sort_order > ${ch.sort_order} ORDER BY sort_order DESC`,
    );

    // 旧章改为第一部分
    await db
      .update(schema.chapters)
      .set({
        content: part1,
        title: ch.title + '（上）',
        word_count: part1.length,
      })
      .where(eq(schema.chapters.chapter_id, chapterId));

    // 插入第二部分
    const [newCh] = await db
      .insert(schema.chapters)
      .values({
        book_id: bookId,
        title: ch.title + '（下）',
        content: part2,
        word_count: part2.length,
        sort_order: ch.sort_order + 1,
      })
      .returning();
    return newCh;
  }
}
