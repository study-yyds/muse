/**
 * 导出记录 — 用户导出作品的审计日志
 * 记录每次导出操作的格式、内容和时间
 */
import {
  pgTable,
  uuid,
  varchar,
  boolean,
  timestamp,
} from 'drizzle-orm/pg-core';
import { books } from './books';
import { users } from './users';

export const export_records = pgTable('export_records', {
  // 主键
  export_id: uuid('export_id').defaultRandom().primaryKey(),

  // 被导出的作品
  book_id: uuid('book_id')
    .references(() => books.book_id, { onDelete: 'cascade' })
    .notNull(),

  // 执行导出的用户（方便跨表查询，不 JOIN books）
  user_id: uuid('user_id')
    .references(() => users.user_id, { onDelete: 'cascade' })
    .notNull(),

  // 导出格式：txt / docx / html / epub
  format: varchar('format', { length: 10 }).notNull(),

  // 是否包含角色设定、世界观和大纲
  include_settings: boolean('include_settings').notNull().default(true),

  // 导出时间
  exported_at: timestamp('exported_at').notNull().defaultNow(),
});
