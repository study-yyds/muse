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
        bound_outline_node_id: schema.chapters.bound_outline_node_id,
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

  async save(
    chapterId: string,
    content: string,
    wordCount: number,
    boundOutlineNodeId?: string | null,
    expectedBookId?: string,
  ) {
    const db = getDb();
    // 校验章节属于该书
    if (expectedBookId) {
      const [ch] = await db.select({ book_id: schema.chapters.book_id }).from(schema.chapters).where(eq(schema.chapters.chapter_id, chapterId)).limit(1);
      if (!ch || ch.book_id !== expectedBookId) throw new Error('章节不属于该作品');
    }
    const data: any = { content, word_count: wordCount, updated_at: sql`NOW()` };
    if (boundOutlineNodeId !== undefined) {
      data.bound_outline_node_id = boundOutlineNodeId || null;
    }
    await db
      .update(schema.chapters)
      .set(data)
      .where(eq(schema.chapters.chapter_id, chapterId));

    // 同步更新作品总字数
    if (expectedBookId) await this.#recalcBookWords(expectedBookId);
  }

  async delete(chapterId: string) {
    const db = getDb();
    const [ch] = await db
      .select({ book_id: schema.chapters.book_id })
      .from(schema.chapters)
      .where(eq(schema.chapters.chapter_id, chapterId))
      .limit(1);
    await db
      .delete(schema.chapters)
      .where(eq(schema.chapters.chapter_id, chapterId));
    if (ch) await this.#recalcBookWords(ch.book_id);
  }

  // 重算作品总字数
  async #recalcBookWords(bookId: string) {
    const db = getDb();
    const [row] = await db
      .select({ total: sql<number>`COALESCE(SUM(${schema.chapters.word_count}), 0)` })
      .from(schema.chapters)
      .where(eq(schema.chapters.book_id, bookId));
    await db
      .update(schema.books)
      .set({ word_count: row?.total ?? 0, updated_at: sql`NOW()` })
      .where(eq(schema.books.book_id, bookId));
  }}
