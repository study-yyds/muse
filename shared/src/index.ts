// @muse/shared — 前后端共享类型定义

// ============== 枚举 ==============

export const BOOK_STATUS = ["draft", "writing", "completed", "deleted"] as const;
export type BookStatus = (typeof BOOK_STATUS)[number];

export const OUTLINE_CHAPTER_STATUS = ["planned", "writing", "completed"] as const;
export type OutlineChapterStatus = (typeof OUTLINE_CHAPTER_STATUS)[number];

export const AI_GENERATE_MODE = ["continue", "rewrite"] as const;
export type AIGenerateMode = (typeof AI_GENERATE_MODE)[number];

export const OUTLINE_GUIDE_MODE = ["template", "ask", "free"] as const;
export type OutlineGuideMode = (typeof OUTLINE_GUIDE_MODE)[number];

export const EXPORT_FORMAT = ["txt", "docx", "html", "epub"] as const;
export type ExportFormat = (typeof EXPORT_FORMAT)[number];

export const TOKEN_USAGE_TYPE = ["platform_key", "user_key"] as const;
export type TokenUsageType = (typeof TOKEN_USAGE_TYPE)[number];

// ============== API 通用响应 ==============

export interface ApiResponse<T = unknown> {
  code: number;
  message?: string;
  data?: T;
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

// ============== 用户 ==============

export interface UserProfile {
  user_id: string;
  phone_number: string;
  avatar_path: string | null;
  created_at: string;
  book_limit: number;
}

// ============== 作品 ==============

export interface BookListItem {
  book_id: string;
  title: string;
  cover_url: string | null;
  word_count: number;
  status: BookStatus;
  last_updated: string;
}

export interface BookDetail extends BookListItem {
  preset_style: string;
  auto_save_interval_sec: number;
  extra?: Record<string, any>;
}

export interface CreateBookRequest {
  title: string;
  preset_style?: string;
}

// ============== 角色 ==============

export interface CustomField {
  key: string;
  value: string;
}

export interface CharacterRelation {
  target_char_id: string;
  target_name?: string;
  relation_type: string;
  description: string | null;
}

export interface CharacterData {
  char_id: string;
  book_id: string;
  name: string;
  gender: string | null;
  age: number | null;
  appearance: string | null;
  personality: string | null;
  catchphrase: string | null;
  speech_style: string | null;
  identity: string | null;
  backstory: string | null;
  motivation: string | null;
  is_main: boolean;
  aliases: string | null;
  custom_fields: CustomField[];
  relations: CharacterRelation[];
  created_at: string;
  updated_at: string;
}

export interface CreateCharacterRequest {
  name: string;
  gender?: string;
  age?: number;
  appearance?: string;
  personality?: string;
  catchphrase?: string;
  speech_style?: string;
  identity?: string;
  backstory?: string;
  motivation?: string;
  is_main?: boolean;
  aliases?: string;
  custom_fields?: CustomField[];
}

// ============== 世界观 ==============

export interface WorldSection {
  name: string;
  content: string;
  sort_order: number;
}

export interface WorldSettingData {
  world_id: string;
  book_id: string;
  sections: WorldSection[];
  created_at: string;
  updated_at: string;
}

// ============== 大纲 ==============

export interface ActStructure {
  act_name: string;
  chapter_ids: string[];
}

export interface OutlineChapterData {
  id: string;
  title: string;
  summary: string;
  bound_chapter_id: string | null;
  status: OutlineChapterStatus;
  sort_order: number;
}

export interface OutlineData {
  outline_id: string;
  book_id: string;
  acts: ActStructure[];
  chapters: OutlineChapterData[];
  created_at: string;
  updated_at: string;
}

export interface DialogMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

// ============== 章节 ==============

export interface ChapterListItem {
  chapter_id: string;
  title: string;
  sort_order: number;
  word_count: number;
  bound_outline_node_id?: string | null;
  status?: OutlineChapterStatus;
  updated_at: string;
}

export interface ChapterDetail {
  chapter_id: string;
  book_id: string;
  title: string;
  content: string;
  sort_order: number;
  word_count: number;
  bound_outline_node_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface SaveChapterRequest {
  content: string;
  word_count: number;
}

// ============== AI 相关 ==============

export interface AIGenerateRequest {
  book_id: string;
  chapter_id: string;
  mode: AIGenerateMode;
  cursor_position: number;
  selected_text?: string;
  instruction?: string;
  style?: string;
  model: string;
  use_platform_key: boolean;
}

export interface AIExtractSettingsRequest {
  book_id: string;
  chapter_id: string;
  model: string;
}

export interface SettingSuggestion {
  type: "character" | "world";
  target_char_id: string | null;
  field?: string;
  value?: string;
  section_name?: string;
  content?: string;
  existing_value: string | null;
  conflict: boolean;
}

export interface AIOutlineDialogRequest {
  book_id: string;
  message: string;
  guide_mode: OutlineGuideMode;
  template_type?: string;
}

export interface AICharTestDialogRequest {
  book_id: string;
  char_id: string;
  message: string;
}

// SSE 事件类型
export const SSE_EVENTS = {
  VERSION: "version",
  CHUNK: "chunk",
  VERSION_DONE: "version_done",
  DIALOG_CHUNK: "dialog_chunk",
  OUTLINE_UPDATE: "outline_update",
  DONE: "done",
  ERROR: "error",
} as const;

export interface SSEDonePayload {
  versions?: number;
}

export interface SSEOutlineUpdatePayload {
  new_chapter?: OutlineChapterData;
  updated_chapter?: OutlineChapterData;
  updated_acts?: ActStructure[];
}

// ============== 模板 ==============

export const TEMPLATE_TYPE = ["character", "world", "outline"] as const;
export type TemplateType = (typeof TEMPLATE_TYPE)[number];

export interface TemplateData {
  template_id: string;
  name: string;
  type: TemplateType;
  category: string;
  description: string;
  preview: Record<string, unknown>;
  is_preset: boolean;
  creator_user_id: string | null;
  created_at: string;
}

// ============== 导出 ==============

export interface ExportRequest {
  format: ExportFormat;
  include_settings: boolean;
}

// ============== 费用 ==============

export interface TokenUsageSummary {
  monthly_limit: number;
  used: number;
  remaining: number;
  reset_date: string;
}

export interface UserApiKeyData {
  id: string;
  base_url: string;
  model_name: string;
  is_active: boolean;
  created_at: string;
}

export interface CreateApiKeyRequest {
  api_key: string;
  base_url: string;
  model_name: string;
}
