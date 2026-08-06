/**
 * 作品与作品设置 — 用户创建的所有小说/故事实体
 * 一个作品绑定一套世界观设定、一组角色、一个大纲、多个章节
 * 软删除通过 deleted_at 标记，status 只表达创作进度
 */
import {
  pgTable,
  uuid,
  varchar,
  integer,
  timestamp,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users';

/**
 * 作品主表
 * 一个用户可以有多个作品（默认上限 3 本）
 * 软删除：deleted_at 非空即视为已删除，7 天内可恢复
 */
export const books = pgTable(
  'books',
  {
    // 主键
    book_id: uuid('book_id').defaultRandom().primaryKey(),

    // 所属用户，级联删除——用户注销时所有作品一起删除
    user_id: uuid('user_id')
      .references(() => users.user_id, { onDelete: 'cascade' })
      .notNull(),

    // 作品名称，最长 200 字符
    title: varchar('title', { length: 200 }).notNull(),

    // 封面图片路径（AI 生成封面存在本地文件系统）
    cover_url: varchar('cover_url', { length: 500 }),

    // 总字数：所有 chapters.word_count 之和，每次保存时增量更新
    word_count: integer('word_count').notNull().default(0),

    // 创作阶段：draft（草稿）→ writing（写作中）→ completed（已完成）
    status: varchar('status', { length: 20 }).notNull().default('draft'),

    // 作品类型：novel（长篇）| short（短篇）
    type: varchar('type', { length: 10 }).notNull().default('novel'),

    // 软删除时间戳：非空 = 已删除，7 天内可恢复，之后定时清理
    deleted_at: timestamp('deleted_at', { withTimezone: true }),

    // 创建时间
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),

    // 最后修改时间（任何子表变更都同步更新）
    updated_at: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // 按用户+状态查询作品列表
    index('idx_books_user_status').on(table.user_id, table.status),
    // 软删除按时间清理（全索引，定时任务用）
    index('idx_books_deleted_at').on(table.deleted_at),
    // status 只允许三个创作阶段值
    sql`CONSTRAINT chk_book_status CHECK (status IN ('draft', 'writing', 'completed'))`,
  ],
);

/**
 * 作品设置表（与 books 一对一）
 * 拆分出来避免 books 表字段膨胀
 */
export const book_settings = pgTable('book_settings', {
  // 关联作品，共享主键
  book_id: uuid('book_id')
    .references(() => books.book_id, { onDelete: 'cascade' })
    .primaryKey(),

  // 预设写作风格：AI 续写时默认使用的文风
  // 可选值：default / light-novel / serious / ancient / plain / colloquial
  preset_style: varchar('preset_style', { length: 50 })
    .notNull()
    .default('default'),

  // 自动保存间隔（秒），默认 300 秒 = 5 分钟
  auto_save_interval_sec: integer('auto_save_interval_sec')
    .notNull()
    .default(300),

  // 扩展设置：如 AI 模仿笔风开关、每日字数目标等
  // 示例：{ "daily_word_goal": 5000, "mimic_style": true }
  extra: jsonb('extra').default({}),

  // 最后修改时间
  updated_at: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});
