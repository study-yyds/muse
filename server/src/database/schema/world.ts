/**
 * 世界观设定 — 作品的底层世界规则描述
 * 使用分区文本框（非严格表单），每本书唯一一份
 * sections JSONB 存储分区数组，AI 按需读取相关分区
 */
import { pgTable, uuid, timestamp, jsonb } from 'drizzle-orm/pg-core';
import { books } from './books';

export const world_settings = pgTable('world_settings', {
  // 主键
  world_id: uuid('world_id').defaultRandom().primaryKey(),

  // 所属作品（一对一关系，级联删除）
  book_id: uuid('book_id')
    .references(() => books.book_id, { onDelete: 'cascade' })
    .unique()
    .notNull(),

  // 分区数组：[{ name: "时代与背景", content: "...", sort_order: 1 }, ...]
  // 默认 4 个分区 + 可添加自定义分区
  sections: jsonb('sections').notNull().default([]),

  // 创建时间
  created_at: timestamp('created_at').notNull().defaultNow(),

  // 最后修改时间
  updated_at: timestamp('updated_at').notNull().defaultNow(),
});
