/**
 * 用户表 — 系统核心身份实体
 * 使用手机号作为唯一登录凭证，UUID 作为不可变主键
 * 支持角色区分（user / admin）和账户状态管理（active / suspended / banned）
 */
import {
  pgTable,
  uuid,
  varchar,
  integer,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm'; // 用于 CHECK 约束的原始 SQL 模板

// 用户主表
export const users = pgTable(
  'users',
  {
    // 主键：UUIDv4，全局唯一不可变
    user_id: uuid('user_id').defaultRandom().primaryKey(),

    // 手机号（明文存储，逐步迁移到加密列）
    phone_number: varchar('phone_number', { length: 20 }).notNull().unique(),

    // 手机号 SHA-256 哈希（用于查询索引）
    phone_hash: varchar('phone_hash', { length: 64 }),

    // 手机号 AES-256-GCM 密文（加密存储）
    phone_encrypted: text('phone_encrypted'),

    // 头像：本地文件路径，可为空（默认头像）
    avatar_path: varchar('avatar_path', { length: 500 }),

    // 角色：用于权限控制，目前支持 user 和 admin
    role: varchar('role', { length: 20 }).notNull().default('user'),

    // 账户状态：active（正常）/ suspended（暂停）/ banned（封禁）
    // 封禁不删除数据，保留作品完整性
    status: varchar('status', { length: 20 }).notNull().default('active'),

    // 注册时间
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),

    // 最后修改时间（换绑手机号、修改角色等操作更新）
    updated_at: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),

    // 作品数配额：默认不限（-1 无限），字段保留供付费档或防滥用；admin 可调整
    // NULL 或 -1 表示无限（V2 与 subscriptions 表联动）
    book_limit: integer('book_limit').notNull().default(-1),

    // 月度 AI 字数额度（计费口径：生成字数=输出字符数），默认免费 3 万字
    // NULL 或 -1 表示无限（admin/付费档）
    monthly_words_quota: integer('monthly_words_quota').notNull().default(30000),
  },
  () => [
    // CHECK 约束：role 只允许这两个值
    sql`CONSTRAINT chk_user_role CHECK (role IN ('user', 'admin'))`,

    // CHECK 约束：status 只允许这三个值
    sql`CONSTRAINT chk_user_status CHECK (status IN ('active', 'suspended', 'banned'))`,
  ],
);
