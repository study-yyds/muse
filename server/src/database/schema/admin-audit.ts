/**
 * 管理员操作审计日志 — 谁在何时对谁做了什么
 * 记录 admin 后台的敏感操作（角色/状态/配额调整），供追溯
 */
import {
  pgTable,
  uuid,
  varchar,
  jsonb,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';
import { users } from './users';

export const admin_audit_logs = pgTable(
  'admin_audit_logs',
  {
    // 主键
    id: uuid('id').defaultRandom().primaryKey(),

    // 操作者（管理员）
    operator_id: uuid('operator_id')
      .references(() => users.user_id, { onDelete: 'set null' })
      .notNull(),

    // 目标用户
    target_user_id: uuid('target_user_id')
      .references(() => users.user_id, { onDelete: 'set null' }),

    // 操作类型：update_user（预留更多类型）
    action: varchar('action', { length: 40 }).notNull(),

    // 操作详情（JSON：改了哪些字段与值）
    detail: jsonb('detail').notNull().default({}),

    // 操作时间
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // 按时间倒序查最近操作
    index('idx_aal_created').on(table.created_at),
  ],
);
