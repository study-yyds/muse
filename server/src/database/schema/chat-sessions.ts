/**
 * AI 对话会话 — 按 (book_id, section) 分组，支持多轮对话归档与恢复
 * 每个 (book_id, section) 同时只有一个 active=true 的会话
 */
import {
  pgTable,
  uuid,
  varchar,
  jsonb,
  boolean,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';
import { books } from './books';

export const ai_chat_sessions = pgTable(
  'ai_chat_sessions',
  {
    id: uuid('id').defaultRandom().primaryKey(),

    book_id: uuid('book_id').references(() => books.book_id, {
      onDelete: 'cascade',
    }),

    // 会话所有者，book_id 为 null 时（引导模式）以此字段鉴权
    user_id: uuid('user_id').notNull(),

    // 对应前端 tab：write / outline / characters / world / settings
    section: varchar('section', { length: 50 }).notNull(),

    // 自动生成标题：日期 + 首条消息摘要
    title: varchar('title', { length: 200 }),

    // 消息数组：[{role, content, action?, adoptedVer?, timestamp}, ...]
    messages: jsonb('messages').notNull().default([]),

    // 当前活跃会话（每个 (book_id, section) 最多一个 active=true）
    active: boolean('active').notNull().default(true),

    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),

    updated_at: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('idx_chat_sessions_book_section').on(table.book_id, table.section),
    index('idx_chat_sessions_active').on(table.active),
  ],
);
