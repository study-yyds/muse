/**
 * 章节 — 作品的正文内容单元
 * 按 sort_order 顺序排列，每章独立存储 content（Markdown 格式）
 * 支持合并/拆分操作，通过 UNIQUE(book_id, sort_order) 保证序号不冲突
 */
import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  timestamp,
  index,
  unique,
} from 'drizzle-orm/pg-core';
import { books } from './books';

// 章节主表
export const chapters = pgTable(
  'chapters',
  {
    // 主键
    chapter_id: uuid('chapter_id').defaultRandom().primaryKey(),

    // 所属作品，级联删除
    book_id: uuid('book_id')
      .references(() => books.book_id, { onDelete: 'cascade' })
      .notNull(),

    // 章节标题（如"第一章：血色月光"）
    title: varchar('title', { length: 200 }).notNull(),

    // 正文内容，Markdown 格式存储，最大依赖 TOAST 自动外存
    content: text('content').notNull().default(''),

    // 排序序号：同一作品内唯一，拆分/合并时用 ORDER BY sort_order DESC 更新避免冲突
    sort_order: integer('sort_order').notNull(),

    // 字数统计：内容编辑后应用层计算
    word_count: integer('word_count').notNull().default(0),

    // 创建时间
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),

    // 最后修改时间：自动保存时更新
    updated_at: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // 按作品+排序获取章节列表（最常用查询）
    index('idx_chapters_book_sort').on(table.book_id, table.sort_order),
    // 按更新时间查最近修改（自动保存冲突检测）
    index('idx_chapters_updated_at').on(table.updated_at),
    // 同一作品内 sort_order 不可重复
    unique('uq_chapters_book_order').on(table.book_id, table.sort_order),
  ],
);
