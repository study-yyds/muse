/**
 * 用户自定义 API Key — 存储用户自己的大模型 API 密钥
 * 使用 AES-256-GCM 加密存储，支持密钥轮换
 * 每个用户同时只能有一个活跃 Key
 */
import {
  pgTable,
  uuid,
  varchar,
  text,
  boolean,
  integer,
  timestamp,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users';

// 用户 API Key 存储表
export const user_api_keys = pgTable(
  'user_api_keys',
  {
    // 主键
    id: uuid('id').defaultRandom().primaryKey(),

    // 所属用户，级联删除
    user_id: uuid('user_id')
      .references(() => users.user_id, { onDelete: 'cascade' })
      .notNull(),

    // AES-256-GCM 加密后的 API Key 密文
    api_key_encrypted: text('api_key_encrypted').notNull(),

    // GCM 模式的随机初始化向量（Base64 编码），每次加密生成新 IV
    encryption_iv: varchar('encryption_iv', { length: 64 }).notNull(),

    // 加密算法版本号：1 = AES-256-GCM，将来换算法时递增
    encryption_version: integer('encryption_version').notNull().default(1),

    // API 端点地址（OpenAI 兼容格式）
    base_url: varchar('base_url', { length: 500 }).notNull(),

    // 模型名称（如 deepseek-chat / gpt-4o）
    model_name: varchar('model_name', { length: 100 }).notNull(),

    // 是否启用：同时只能有一个 active Key
    is_active: boolean('is_active').notNull().default(true),

    // 最后使用时间，用于活跃度统计
    last_used_at: timestamp('last_used_at'),

    // 创建时间
    created_at: timestamp('created_at').notNull().defaultNow(),
  },
  () => [
    // 部分唯一索引：确保每个用户只有一个活跃 Key
    // WHERE is_active = true 保证只在活跃 Key 上生效
    sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_user_active_key ON user_api_keys(user_id) WHERE is_active = true`,
  ],
);
