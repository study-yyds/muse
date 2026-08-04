/**
 * 角色与角色关系 — 作品中的人物实体
 * 固定字段（姓名/性格/背景等）+ 自定义字段（JSONB 键值对）
 * 角色关系存储三元组：(源角色, 目标角色, 关系类型)，禁止自引用
 */
import {
  pgTable,
  uuid,
  varchar,
  integer,
  text,
  timestamp,
  jsonb,
  boolean,
  index,
  unique,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { books } from './books';

/**
 * 角色主表
 * 每个作品可以有多个角色
 * 固定字段用列存储（可建索引、精确查询），自定义字段用 JSONB（灵活扩展）
 */
export const characters = pgTable(
  'characters',
  {
    // 主键
    char_id: uuid('char_id').defaultRandom().primaryKey(),

    // 所属作品，级联删除
    book_id: uuid('book_id')
      .references(() => books.book_id, { onDelete: 'cascade' })
      .notNull(),

    // 角色姓名
    name: varchar('name', { length: 100 }).notNull(),

    // 性别
    gender: varchar('gender', { length: 20 }),

    // 年龄
    age: integer('age'),

    // 外貌描写（长文本）
    appearance: text('appearance'),

    // 性格描述（长文本）
    personality: text('personality'),

    // 口头禅
    catchphrase: varchar('catchphrase', { length: 500 }),

    // 说话风格：如"冷淡""滔滔不绝""文绉绉"
    speech_style: varchar('speech_style', { length: 500 }),

    // 身份/职业：如"流浪剑客""高中生"
    identity: varchar('identity', { length: 200 }),

    // 背景故事（长文本）
    backstory: text('backstory'),

    // 动机/目标（长文本）
    motivation: text('motivation'),

    // 是否为主要角色（始终注入 AI 上下文）
    is_main: boolean('is_main').notNull().default(false),

    // 角色别名：逗号分隔的称呼列表，用于正文匹配（如"墨哥,林兄,那剑客"）
    aliases: text('aliases'),

    // 自定义键值对：如 [{ "key": "血型", "value": "AB" }, ...]
    custom_fields: jsonb('custom_fields').default([]),

    // AI 生成的角色立绘图路径
    avatar_url: varchar('avatar_url', { length: 500 }),

    // 创建时间
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),

    // 最后修改时间
    updated_at: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // 按作品查所有角色
    index('idx_characters_book_id').on(table.book_id),
  ],
);

/**
 * 角色关系表
 * 存储两个角色之间的有向关系
 * 唯一约束防止重复关系，CHECK 约束禁止自引用
 */
export const character_relations = pgTable(
  'character_relations',
  {
    // 主键
    id: uuid('id').defaultRandom().primaryKey(),

    // 关系源角色
    source_char_id: uuid('source_char_id')
      .references(() => characters.char_id, { onDelete: 'cascade' })
      .notNull(),

    // 关系目标角色
    target_char_id: uuid('target_char_id')
      .references(() => characters.char_id, { onDelete: 'cascade' })
      .notNull(),

    // 关系类型：如"朋友""宿敌""师徒""恋慕"
    relation_type: varchar('relation_type', { length: 50 }).notNull(),

    // 关系描述（可选）
    description: text('description'),
  },
  (table) => [
    // 三元组唯一：防止 (A→B, "朋友") 重复插入
    unique('uq_char_relations').on(
      table.source_char_id,
      table.target_char_id,
      table.relation_type,
    ),
    // 禁止自我关系（A→A）
    sql`CONSTRAINT no_self_relation CHECK (source_char_id != target_char_id)`,
    // 按源角色查其所有关系
    index('idx_rel_source').on(table.source_char_id),
    // 按目标角色查谁关联了它
    index('idx_rel_target').on(table.target_char_id),
  ],
);
