-- 0002_add_chat_sessions.sql
-- AI 对话会话，支持多轮对话归档与恢复
CREATE TABLE IF NOT EXISTS ai_chat_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id UUID NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
  section VARCHAR(50) NOT NULL,
  title VARCHAR(200),
  messages JSONB NOT NULL DEFAULT '[]',
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_sessions_book_section
  ON ai_chat_sessions(book_id, section);

CREATE INDEX IF NOT EXISTS idx_chat_sessions_active
  ON ai_chat_sessions(active);
