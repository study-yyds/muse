/**
 * ============================================================
 *  数据库 Schema 聚合导出
 * ============================================================
 *  所有表定义在此集中导出，供 Drizzle 连接实例使用。
 *  每个 schema 文件负责一个或多个业务相关的表定义。
 *  导出顺序：
 *    1. 核心实体（users → books）
 *    2. 业务数据（characters → world → chapters → outline）
 *    3. 辅助数据（exports / api-keys / usage / templates / char-test）
 * ============================================================
 */

// ---- 用户与认证 ----
export { users } from './users';
export { verification_codes } from './auth';

// ---- 作品核心 ----
export { books, book_settings } from './books';

// ---- 角色系统 ----
export { characters, character_relations } from './characters';

// ---- 世界观 ----
export { world_settings } from './world';

// ---- 章节 ----
export { chapters } from './chapters';

// ---- 大纲系统（4 张子表） ----
export {
  outlines,
  outline_chapters,
  outline_act_chapters,
  outline_dialog_sessions,
} from './outline';

// ---- 导出审计 ----
export { export_records } from './exports';

// ---- API Key 管理 ----
export { user_api_keys } from './api-keys';

// ---- Token 用量 ----
export { token_usage_records, user_monthly_quota } from './usage';

// ---- 模板库 ----
export { templates } from './templates';

// ---- AI 对话会话 ----
export { ai_chat_sessions } from './chat-sessions';

// ---- 角色测试对话 ----
export { char_test_dialog_sessions } from './char-test';
