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
    // 注意：DB 查询失败必须原样抛出（500），不能吞成 401——
    // 否则后端/数据库抖动会被前端误判为"登录过期"而清掉登录态
    const [user] = await getDb()
      .select({ status: schema.users.status })
      .from(schema.users)
      .where(eq(schema.users.user_id, payload.sub))
      .limit(1);
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
