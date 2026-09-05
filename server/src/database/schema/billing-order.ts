/**
 * 账单订单 — 套餐购买记录
 * 模拟支付阶段：创建订单 → mock 收银台"支付成功" → 应用额度。
 * 真实支付接入后，pay 环节替换为网关回调/查询，表结构不变。
 */
import {
  pgTable,
  uuid,
  varchar,
  integer,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';
import { users } from './users';

export const billing_orders = pgTable(
  'billing_orders',
  {
    // 主键
    id: uuid('id').defaultRandom().primaryKey(),

    // 下单用户
    user_id: uuid('user_id')
      .references(() => users.user_id, { onDelete: 'cascade' })
      .notNull(),

    // 套餐档位：basic / pro
    plan_id: varchar('plan_id', { length: 20 }).notNull(),

    // 应付金额（展示用，如 "¥19"）
    amount: varchar('amount', { length: 20 }).notNull(),

    // 该档位对应的月度字数额度（支付成功时写入 users.monthly_words_quota）
    quota_words: integer('quota_words').notNull(),

    // 状态：pending / paid / cancelled
    status: varchar('status', { length: 20 }).notNull().default('pending'),

    // 支付时间
    paid_at: timestamp('paid_at', { withTimezone: true }),

    // 订阅到期时间：支付成功时写入（paid_at + 30 天）。
    // 到期由 maintenance 全量扫描 + 额度检查惰性降级共同处理（见 billing/subscription-ops.ts）。
    // NULL = 未支付/历史遗留订单
    expires_at: timestamp('expires_at', { withTimezone: true }),

    // 到期处理标记：每张过期订单只评估一次（降级或判定"额度已被 admin 改过"后打标）。
    // 打过标后不再触发任何降级——admin 之后的手动额度调整永久生效，不会被重复回退
    downgraded_at: timestamp('downgraded_at', { withTimezone: true }),

    // 下单时间
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // 用户订单列表
    index('idx_bo_user').on(table.user_id),
    // 按时间倒序
    index('idx_bo_created').on(table.created_at),
  ],
);
