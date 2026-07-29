/**
 * 用户表 — 系统核心身份实体
 * 使用手机号作为唯一登录凭证，UUID 作为不可变主键
 * 支持角色区分（user / admin）和账户状态管理（active / suspended / banned）
 */
import {
  pgTable, // Drizzle 表定义函数
  uuid, // UUID 类型，主键和外部引用用
  varchar, // 变长字符串，带长度限制
  integer, // 整数，用于计数和配额
  timestamp, // 时间戳，带时区
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm'; // 用于 CHECK 约束的原始 SQL 模板

// 用户主表
export const users = pgTable(
  'users',
  {
    // 主键：UUIDv4，全局唯一不可变
    user_id: uuid('user_id').defaultRandom().primaryKey(),

    // 登录凭证：手机号，全局唯一
    phone_number: varchar('phone_number', { length: 20 }).notNull().unique(),

    // 头像：本地文件路径，可为空（默认头像）
    avatar_path: varchar('avatar_path', { length: 500 }),

    // 角色：用于权限控制，目前支持 user 和 admin
    role: varchar('role', { length: 20 }).notNull().default('user'),

    // 账户状态：active（正常）/ suspended（暂停）/ banned（封禁）
    // 封禁不删除数据，保留作品完整性
    status: varchar('status', { length: 20 }).notNull().default('active'),

    // 注册时间
    created_at: timestamp('created_at').notNull().defaultNow(),

    // 最后修改时间（换绑手机号、修改角色等操作更新）
    updated_at: timestamp('updated_at').notNull().defaultNow(),

    // 免费配额：最多创建的作品数，默认 3 本
    // NULL 或 -1 表示无限（V2 与 subscriptions 表联动）
    book_limit: integer('book_limit').notNull().default(3),
  },
  () => [
    // CHECK 约束：role 只允许这两个值
    sql`CONSTRAINT chk_user_role CHECK (role IN ('user', 'admin'))`,

    // CHECK 约束：status 只允许这三个值
    sql`CONSTRAINT chk_user_status CHECK (status IN ('active', 'suspended', 'banned'))`,
  ],
);
