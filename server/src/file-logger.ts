import { appendFileSync, mkdirSync } from 'fs';
import path from 'path';

/**
 * 极简文件日志：console.error 同步落盘（按天分文件）+ 未捕获异常记录
 * 部署层（pm2/docker）就位前，保证错误日志不随进程重启丢失
 */
export function setupFileLogging(): void {
  const logsDir = path.join(__dirname, '..', 'logs');
  try {
    mkdirSync(logsDir, { recursive: true });
  } catch {
    /* 目录已存在 */
  }
  const errFile = () =>
    path.join(logsDir, `error-${new Date().toISOString().slice(0, 10)}.log`);
  const writeErr = (line: string) => {
    try {
      appendFileSync(errFile(), `${new Date().toISOString()} ${line}\n`);
    } catch {
      /* 落盘失败不阻断 */
    }
  };

  const origErr = console.error;
  console.error = (...args: any[]) => {
    writeErr(
      args
        .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
        .join(' '),
    );
    origErr.apply(console, args);
  };

  process.on('uncaughtException', (err) => {
    writeErr(`[uncaughtException] ${err.stack || err.message}`);
    origErr('[uncaughtException]', err);
  });
  process.on('unhandledRejection', (reason: any) => {
    writeErr(`[unhandledRejection] ${reason?.stack || reason}`);
    origErr('[unhandledRejection]', reason);
  });
}
