/**
 * 用户自定义 API Key — 存储用户自己的大模型 API 密钥
 * 使用 AES-256-GCM 加密存储，支持多 Key 管理
 */
import {
  pgTable,
  uuid,
  varchar,
  text,
  boolean,
  integer,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';
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

    // 用户起的别名，如"公司的深言V4"
    name: varchar('name', { length: 50 }).notNull().default('未命名'),

    // AES-256-GCM 加密后的 API Key 密文
    api_key_encrypted: text('api_key_encrypted').notNull(),

    // GCM 模式的随机初始化向量（Base64 编码）
    encryption_iv: varchar('encryption_iv', { length: 64 }).notNull(),

    // 加密算法版本号：1 = AES-256-GCM
    encryption_version: integer('encryption_version').notNull().default(1),

    // API 端点地址（OpenAI 兼容格式）
    base_url: varchar('base_url', { length: 500 }).notNull(),

    // 模型名称
    model_name: varchar('model_name', { length: 100 }).notNull(),

    // 用途：chat（文本）/ image（生图）/ both（通用）
    usage: varchar('usage', { length: 10 }).notNull().default('chat'),

    // 是否启用
    is_active: boolean('is_active').notNull().default(true),

    // 最后使用时间
    last_used_at: timestamp('last_used_at', { withTimezone: true }),

    // 创建时间
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('idx_apikey_user').on(table.user_id),
  ],
);
