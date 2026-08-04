-- 0003_add_avatar_url.sql
-- AI 生成角色立绘图
ALTER TABLE characters ADD COLUMN IF NOT EXISTS avatar_url varchar(500);
