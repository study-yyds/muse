import { Injectable } from '@nestjs/common';
import { eq, asc, desc, sql } from 'drizzle-orm';
import { getDb, schema } from '../database/connection';

@Injectable()
export class OutlineService {
  async get(bookId: string) {
    const db = getDb();
    const [outline] = await db
      .select()
      .from(schema.outlines)
      .where(eq(schema.outlines.book_id, bookId))
      .limit(1);
    if (!outline) return null;

    const chapters = await db
      .select()
      .from(schema.outline_chapters)
      .where(eq(schema.outline_chapters.outline_id, outline.outline_id))
      .orderBy(asc(schema.outline_chapters.sort_order));

    const actChapters = await db
      .select()
      .from(schema.outline_act_chapters)
      .where(eq(schema.outline_act_chapters.outline_id, outline.outline_id))
      .orderBy(asc(schema.outline_act_chapters.sort_order));

    // 组装分幕结构
    const acts: Record<string, string[]> = {};
    for (const ac of actChapters) {
      if (!acts[ac.act_name]) acts[ac.act_name] = [];
      acts[ac.act_name].push(ac.chapter_id);
    }

    return {
      outline_id: outline.outline_id,
      book_id: outline.book_id,
      acts: Object.entries(acts).map(([act_name, chapter_ids]) => ({
        act_name,
        chapter_ids,
      })),
      chapters,
      created_at: outline.created_at,
      updated_at: outline.updated_at,
    };
  }

  async addChapter(bookId: string, title: string, summary: string, actName?: string) {
    const db = getDb();
    // 确保大纲存在
    let [outline] = await db
      .select({ outline_id: schema.outlines.outline_id })
      .from(schema.outlines)
      .where(eq(schema.outlines.book_id, bookId))
      .limit(1);
    if (!outline) {
      [outline] = await db
        .insert(schema.outlines)
        .values({ book_id: bookId })
        .returning({ outline_id: schema.outlines.outline_id });
    }

    const [last] = await db
      .select({
        max: sql<number>`coalesce(max(${schema.outline_chapters.sort_order}), 0)`,
      })
      .from(schema.outline_chapters)
      .where(eq(schema.outline_chapters.outline_id, outline.outline_id));

    const [ch] = await db
      .insert(schema.outline_chapters)
      .values({
        outline_id: outline.outline_id,
        title,
        summary,
        sort_order: Number(last?.max ?? 0) + 1,
      })
      .returning();

    // 有幕名时写入幕-节点关系表
    if (actName) {
      const [lastAct] = await db
        .select({
          max: sql<number>`coalesce(max(${schema.outline_act_chapters.sort_order}), 0)`,
        })
        .from(schema.outline_act_chapters)
        .where(
          eq(schema.outline_act_chapters.outline_id, outline.outline_id),
        );
      await db.insert(schema.outline_act_chapters).values({
        outline_id: outline.outline_id,
        act_name: actName,
        chapter_id: ch.id,
        sort_order: Number(lastAct?.max ?? 0) + 1,
      });
    }

    return ch;
  }

  async updateChapter(
    chapterId: string,
    data: { title?: string; summary?: string },
  ) {
    const db = getDb();
    await db
      .update(schema.outline_chapters)
      .set(data)
      .where(eq(schema.outline_chapters.id, chapterId));
  }

  async deleteChapter(chapterId: string) {
    const db = getDb();
    await db
      .delete(schema.outline_chapters)
      .where(eq(schema.outline_chapters.id, chapterId));
  }

  // 绑定大纲节点到正文章节
  async bind(chapterId: string, boundChapterId: string | null) {
    const db = getDb();
    await db
      .update(schema.outline_chapters)
      .set({
        bound_chapter_id: boundChapterId,
        status: boundChapterId ? 'writing' : 'planned',
        updated_at: sql`NOW()`,
      })
      .where(eq(schema.outline_chapters.id, chapterId));
  }
}
