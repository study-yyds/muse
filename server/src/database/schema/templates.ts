/**
 * 模板库 — 角色/世界观/大纲的预设与用户共享模板
 * 分为平台预设（is_preset=true）和用户共享（is_public=true）
 * preview 存摘要信息，data 存完整模板数据
 */
import {
  pgTable,
  uuid,
  varchar,
  text,
  boolean,
  jsonb,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';
import { users } from './users';

export const templates = pgTable(
  'templates',
  {
    // 主键
    template_id: uuid('template_id').defaultRandom().primaryKey(),

    // 模板名称（如"冷面剑客""赛博朋克世界"）
    name: varchar('name', { length: 200 }).notNull(),

    // 模板类型：character / world / outline
    type: varchar('type', { length: 20 }).notNull(),

    // 分类标签（如"仙侠""都市""轻小说"）
    category: varchar('category', { length: 50 }).notNull(),

    // 模板描述
    description: text('description'),

    // 预览摘要信息（如"古风修仙角色 - 冷酷师尊型"）
    preview: jsonb('preview').notNull().default({}),

    // 完整模板数据：角色存所有固定字段+自定义字段，世界观存 sections 数组
    data: jsonb('data').notNull().default({}),

    // 是否为平台预置模板
    is_preset: boolean('is_preset').notNull().default(false),

    // 是否为共享到公共模板库
    is_public: boolean('is_public').notNull().default(false),

    // 创建者（预置模板为空，用户创建的记用户，注销时 SET NULL）
    creator_user_id: uuid('creator_user_id').references(() => users.user_id, {
      onDelete: 'set null',
    }),

    // 创建时间
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // 按创建者查自己的模板
    index('idx_tpl_creator').on(table.creator_user_id),
    // 按类型+分类查公共模板
    index('idx_tpl_type_cat').on(table.type, table.category),
  ],
);
