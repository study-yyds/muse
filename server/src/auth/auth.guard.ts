import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../database/connection';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers.authorization;
    const match = authHeader?.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      // 显式 401：前端据此清除 token 并跳登录页（此前返回 false 会变成 403）
      throw new UnauthorizedException('登录已过期，请重新登录');
    }
    const token = match[1];
    if (!token) {
      throw new UnauthorizedException('登录已过期，请重新登录');
    }

    // JWT 验证失败（过期/签名错误/格式错误）→ 401，前端据此清登录态
    let payload: any;
    try {
      payload = this.jwt.verify(token);
    } catch {
      throw new UnauthorizedException('登录已过期，请重新登录');
    }
    if (!payload.sub || typeof payload.sub !== 'string') {
      throw new UnauthorizedException('登录已过期，请重新登录');
    }

    // 检查用户状态：封禁/暂停均拒绝访问。
    // 网络抖动对策（Neon 海外库间歇性连接超时，实测 10 秒超时导致全站 500）：
    // 查询失败重试一次；仍失败则放行——JWT 已验真，封禁拦截是次要防线，
    // 可用性优先（封禁用户在 DB 故障窗口最多多活几分钟）。
    // 注：不能吞成 401，否则前端会误判"登录过期"清掉登录态。
    let user: { status: string | null } | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        [user] = await getDb()
          .select({ status: schema.users.status })
          .from(schema.users)
          .where(eq(schema.users.user_id, payload.sub))
          .limit(1);
        break;
      } catch (e: any) {
        if (attempt === 1) {
          console.error(
            '[AuthGuard] user status query failed after retry, failing open:',
            e?.message ?? e,
          );
          request.userId = payload.sub;
          return true;
        }
        // 重试前等 1 秒（网络抖动通常瞬间恢复）
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    if (!user) {
      throw new UnauthorizedException('登录已过期，请重新登录');
    }
    if (user.status === 'banned') {
      throw new ForbiddenException('账号已被封禁');
    }
    if (user.status === 'suspended') {
      throw new ForbiddenException('账号已被暂停使用');
    }

    request.userId = payload.sub;
    return true;
  }
}
