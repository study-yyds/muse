/**
 * 角色测试对话 — 作者与角色进行对话测试，验证人设一致性
 * 多轮对话存储为 JSONB 消息数组
 */
import { pgTable, uuid, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { characters } from './characters';

export const char_test_dialog_sessions = pgTable(
  'char_test_dialog_sessions',
  {
    // 主键
    session_id: uuid('session_id').defaultRandom().primaryKey(),

    // 测试的角色
    char_id: uuid('char_id')
      .references(() => characters.char_id, { onDelete: 'cascade' })
      .notNull(),

    // 对话消息列表：[{ role: "user"|"assistant", content: "...", timestamp: "..." }]
    messages: jsonb('messages').notNull().default([]),

    // 最后活跃时间（每次新消息更新）
    updated_at: timestamp('updated_at').notNull().defaultNow(),

    // 创建时间
    created_at: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    // 按角色查其所有对话历史
    index('idx_ctds_char').on(table.char_id),
  ],
);
