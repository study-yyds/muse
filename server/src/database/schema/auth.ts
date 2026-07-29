/**
 * 验证码存储 — 手机号登录的临时验证码
 * 5 分钟有效期，一次性消费（used 标记）
 * 定时任务按 expires_at 清理过期记录
 */
import {
  pgTable,
  uuid,
  varchar,
  boolean,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';

export const verification_codes = pgTable(
  'verification_codes',
  {
    // 主键
    id: uuid('id').defaultRandom().primaryKey(),

    // 接收验证码的手机号
    phone_number: varchar('phone_number', { length: 20 }).notNull(),

    // 6 位数字验证码（V1 阶段随机生成，V2 接入短信服务）
    code: varchar('code', { length: 6 }).notNull(),

    // 过期时间：创建时间 + 5 分钟
    expires_at: timestamp('expires_at').notNull(),

    // 是否已使用：防止验证码被重复消费
    used: boolean('used').notNull().default(false),

    // 创建时间
    created_at: timestamp('created_at').notNull().defaultNow(),
  },
  // 索引
  (table) => [
    // 按手机号查询最近验证码（获取验证码限流）
    index('idx_vc_phone_created').on(table.phone_number, table.created_at),
    // 按过期时间清理（定时任务）
    index('idx_vc_expires').on(table.expires_at),
  ],
);
