import { getDb, schema } from './database/connection';
import { sql } from 'drizzle-orm';
import { unlink, readdir, stat } from 'fs/promises';
import path from 'path';
import { downgradeExpiredSubscriptions } from './billing/subscription-ops';

/**
 * 临时产物清理：按文件名模式匹配，超龄删除。
 * 保留：img-*（封面/头像，被 DB 引用）、voice-previews（试听缓存）
 */
async function cleanupTempFiles(): Promise<number> {
  const uploadsDir = path.join(__dirname, '..', 'public', 'uploads');
  const patterns = [
    { match: /^audio-line-/, maxAgeMs: 7 * 24 * 3600 * 1000 }, // 逐行配音
    { match: /^audio-/, maxAgeMs: 7 * 24 * 3600 * 1000 }, // 合并配音
    { match: /^tts-temp-/, maxAgeMs: 24 * 3600 * 1000 }, // TTS 临时分段
    { match: /^concat-/, maxAgeMs: 24 * 3600 * 1000 }, // 音频拼接清单
    { match: /^promo-/, maxAgeMs: 7 * 24 * 3600 * 1000 }, // 推文视频
    { match: /^promo-pack-/, maxAgeMs: 7 * 24 * 3600 * 1000 }, // 素材包
    { match: /^seg-/, maxAgeMs: 24 * 3600 * 1000 }, // 视频片段
    { match: /^bg-/, maxAgeMs: 7 * 24 * 3600 * 1000 }, // 上传背景视频
  ];

  let removed = 0;
  for (const sub of ['', 'videos']) {
    const dir = path.join(uploadsDir, sub);
    const files = await readdir(dir).catch(() => []);
    for (const f of files) {
      const p = patterns.find((x) => x.match.test(f));
      if (!p) continue;
      try {
        const st = await stat(path.join(dir, f));
        if (Date.now() - st.mtimeMs > p.maxAgeMs) {
          await unlink(path.join(dir, f));
          removed++;
        }
      } catch {
        /* 单个文件失败不影响其他 */
      }
    }
  }
  return removed;
}

/**
 * 启动定时维护任务：
 * 1. 彻底删除 7 天前软删除的作品（FK 级联清理子表）
 * 2. 清理超龄临时产物文件
 * 返回 interval 句柄（测试可清理）
 */
export function startMaintenanceTasks(): NodeJS.Timeout {
  const run = async () => {
    try {
      const db = getDb();
      const removedFiles = await cleanupTempFiles();
      const removedBooks = await db
        .delete(schema.books)
        .where(
          sql`${schema.books.deleted_at} IS NOT NULL AND ${schema.books.deleted_at} < NOW() - INTERVAL '7 days'`,
        );
      // 清理过期验证码（过期超过 1 天），防止表无限膨胀
      const removedCodes = await db
        .delete(schema.verification_codes)
        .where(
          sql`${schema.verification_codes.expires_at} < NOW() - INTERVAL '1 day'`,
        );
      // 订阅到期自动降级（付费用户额度降回免费档）
      const downgraded = await downgradeExpiredSubscriptions();
      if (removedFiles > 0) {
        console.log(`[maintenance] removed ${removedFiles} temp files`);
      }
      if (removedBooks.rowCount > 0) {
        console.log(
          `[maintenance] removed ${removedBooks.rowCount} expired soft-deleted books`,
        );
      }
      if (removedCodes.rowCount > 0) {
        console.log(
          `[maintenance] removed ${removedCodes.rowCount} expired verification codes`,
        );
      }
      if (downgraded > 0) {
        console.log(`[maintenance] downgraded ${downgraded} expired subscriptions`);
      }
    } catch (e: any) {
      console.error('[maintenance] cleanup failed:', e.message);
    }
  };
  run(); // 启动即跑一次
  return setInterval(run, 60 * 60 * 1000); // 每小时
}
