/**
 * 大纲系统 — 作品的章节规划与 AI 共创对话
 * outlines: 每本书一个大纲根节点
 * outline_chapters: 章节摘要节点，可绑定到实际章节
 * outline_act_chapters: 分幕骨架关系表（替代旧 JSONB acts 方案）
 * outline_dialog_sessions: 大纲 AI 对话历史
 */
import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  timestamp,
  jsonb,
  index,
  unique,
  primaryKey,
} from 'drizzle-orm/pg-core';
import { books } from './books';
import { chapters } from './chapters';

/**
 * 大纲根表 — 每本书有且仅有一个大纲
 */
export const outlines = pgTable('outlines', {
  // 主键
  outline_id: uuid('outline_id').defaultRandom().primaryKey(),

  // 所属作品（一对一）
  book_id: uuid('book_id')
    .references(() => books.book_id, { onDelete: 'cascade' })
    .unique()
    .notNull(),

  // 创建时间
  created_at: timestamp('created_at').notNull().defaultNow(),

  // 最后修改时间
  updated_at: timestamp('updated_at').notNull().defaultNow(),
});

/**
 * 大纲章节节点 — 大纲中的每个规划章节
 * bound_chapter_id 可选，绑定后标记为 writing/completed
 * 删除绑定章节时 SET NULL 并回退状态到 planned
 */
export const outline_chapters = pgTable(
  'outline_chapters',
  {
    // 主键
    id: uuid('id').defaultRandom().primaryKey(),

    // 所属大纲
    outline_id: uuid('outline_id')
      .references(() => outlines.outline_id, { onDelete: 'cascade' })
      .notNull(),

    // 章节标题
    title: varchar('title', { length: 200 }).notNull(),

    // 章节摘要
    summary: text('summary').notNull(),

    // 绑定的实际章节（可为空，表示还未开始写）
    bound_chapter_id: uuid('bound_chapter_id').references(
      () => chapters.chapter_id,
      { onDelete: 'set null' },
    ),

    // 节点状态：planned（规划中）/ writing（写作中）/ completed（已完成）
    status: varchar('status', { length: 20 }).notNull().default('planned'),

    // 排序序号：同一大纲内唯一
    sort_order: integer('sort_order').notNull(),

    // 最后修改时间
    updated_at: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [
    // 按大纲查所有节点
    index('idx_oc_outline').on(table.outline_id),
    // 按绑定章节查（反向查找哪个大纲节点绑定了这个章节）
    index('idx_oc_bound_chapter').on(table.bound_chapter_id),
    // 同一大纲内 sort_order 不重复
    unique('uq_oc_outline_order').on(table.outline_id, table.sort_order),
  ],
);

/**
 * 大纲分幕关系表 — 替代旧 JSONB acts 方案
 * 一个章节节点只能属于一个幕（PRIMARY KEY chapter_id）
 * sort_order 保证同一幕内排列有序
 */
export const outline_act_chapters = pgTable(
  'outline_act_chapters',
  {
    // 所属大纲
    outline_id: uuid('outline_id')
      .references(() => outlines.outline_id, { onDelete: 'cascade' })
      .notNull(),

    // 幕名称：如"开端""对抗""结局"
    act_name: varchar('act_name', { length: 50 }).notNull(),

    // 章节节点
    chapter_id: uuid('chapter_id')
      .references(() => outline_chapters.id, { onDelete: 'cascade' })
      .notNull(),

    // 幕内排序
    sort_order: integer('sort_order').notNull(),
  },
  (table) => [
    // 一个章节只能属于一个幕
    primaryKey({ columns: [table.chapter_id] }),
    // 同一幕内 sort_order 不重复
    unique('uq_oac_act_order').on(
      table.outline_id,
      table.act_name,
      table.sort_order,
    ),
  ],
);

/**
 * 大纲对话历史 — AI 共创大纲的对话记录
 * messages JSONB 存储完整对话，对长对话需注意膨胀（V2 可拆分）
 */
export const outline_dialog_sessions = pgTable(
  'outline_dialog_sessions',
  {
    // 主键
    session_id: uuid('session_id').defaultRandom().primaryKey(),

    // 所属大纲
    outline_id: uuid('outline_id')
      .references(() => outlines.outline_id, { onDelete: 'cascade' })
      .notNull(),

    // 对话消息：[{ role: "user"|"assistant", content: "...", timestamp: "..." }]
    messages: jsonb('messages').notNull().default([]),

    // 创建时间
    created_at: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    // 按大纲查所有对话历史
    index('idx_ods_outline').on(table.outline_id),
  ],
);
