/**
 * Token 用量与月度配额 — AI 调用计费基础设施
 * token_usage: 每笔 AI 请求的明细记录
 * user_monthly_quota: 月度汇总，用原子 UPDATE 避免竞态
 */
import {
  pgTable,
  uuid,
  varchar,
  integer,
  timestamp,
  index,
  primaryKey,
} from 'drizzle-orm/pg-core';
import { users } from './users';
import { books } from './books';

/**
 * Token 用量明细表
 * 每次 AI 请求完成后写一条记录
 */
export const token_usage_records = pgTable(
  'token_usage_records',
  {
    // 主键
    id: uuid('id').defaultRandom().primaryKey(),

    // 消耗用户（级联删除：用户注销时保留记录用于平台统计）
    user_id: uuid('user_id')
      .references(() => users.user_id, { onDelete: 'cascade' })
      .notNull(),

    // 产生用量时所在的作品（删除作品时 SET NULL，保留用量记录）
    book_id: uuid('book_id').references(() => books.book_id, {
      onDelete: 'set null',
    }),

    // 本次消耗的 token 数
    token_count: integer('token_count').notNull(),

    // 使用的模型名称
    model_name: varchar('model_name', { length: 100 }).notNull(),

    // 用量类型：platform_key（平台承担费用）/ user_key（用户自担）
    usage_type: varchar('usage_type', { length: 20 }).notNull(),

    // 记录时间
    created_at: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    // 按用户+时间查询月度用量
    index('idx_tur_user_created').on(table.user_id, table.created_at),
    // 按作品查询用量
    index('idx_tur_book').on(table.book_id),
  ],
);

/**
 * 月度用量汇总表
 * 每次 AI 请求后用原子 UPDATE 更新：SET used_tokens = used_tokens + $delta
 * 避免先读后写的竞态条件
 */
export const user_monthly_quota = pgTable(
  'user_monthly_quota',
  {
    // 用户
    user_id: uuid('user_id')
      .references(() => users.user_id, { onDelete: 'cascade' })
      .notNull(),

    // 月份标识：格式 "YYYY-MM"（如 "2026-07"）
    month: varchar('month', { length: 7 }).notNull(),

    // 本月已用 token 数（原子增量更新）
    used_tokens: integer('used_tokens').notNull().default(0),
  },
  (table) => [
    // (用户, 月份) 联合主键
    primaryKey({ columns: [table.user_id, table.month] }),
  ],
);
