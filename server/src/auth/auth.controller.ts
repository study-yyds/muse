import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Req,
  Res,
  Param,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { AuthGuard } from './auth.guard';

@Controller('api')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('auth/send-code')
  async sendCode(@Body('phone_number') phone: string) {
    // 校验类错误（格式/频率）由 service 抛 BadRequestException → 400；
    // DB 等错误直接 500
    const result = await this.auth.sendCode(phone);
    return { code: 200, message: '验证码已发送', data: result };
  }

  @Post('auth/login')
  async login(
    @Body('phone_number') phone: string,
    @Body('code') code: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    try {
      const result = await this.auth.login(phone, code);
      // 种 httpOnly Cookie 供 /uploads 静态资源鉴权使用（<img> 无法携带 Authorization 头）
      res.cookie('muse_token', result.access_token, {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        maxAge: 12 * 60 * 60 * 1000, // 与 JWT 有效期一致
      });
      return { code: 200, data: result };
    } catch (e: any) {
      return { code: 401, message: e.message ?? '验证码错误或已过期' };
    }
  }

  @Post('auth/logout')
  logout(@Res({ passthrough: true }) res: Response) {
    // 清除 Cookie（客户端 localStorage 的 token 由前端登出逻辑清理）
    res.clearCookie('muse_token', { path: '/' });
    return { code: 200, message: '已退出登录' };
  }

  @UseGuards(AuthGuard)
  @Get('user/profile')
  async profile(@Req() req: Request) {
    const user = await this.auth.getProfile((req as any).userId);
    return user
      ? { code: 200, data: user }
      : { code: 404, message: '用户不存在' };
  }

  // ============ API Key 管理 ============

  @UseGuards(AuthGuard)
  @Get('user/api-keys')
  async listKeys(@Req() req: Request) {
    const data = await this.auth.listApiKeys((req as any).userId);
    return { code: 200, data };
  }

  @UseGuards(AuthGuard)
  @Post('user/api-keys')
  async createKey(
    @Body()
    body: {
      name: string;
      api_key: string;
      base_url: string;
      model_name: string;
      usage: string;
    },
    @Req() req: Request,
  ) {
    const data = await this.auth.createApiKey((req as any).userId, body);
    return { code: 201, data };
  }

  @UseGuards(AuthGuard)
  @Put('user/api-keys/:id')
  async updateKey(
    @Param('id') id: string,
    @Body()
    body: {
      name?: string;
      api_key?: string;
      base_url?: string;
      model_name?: string;
      usage?: string;
      is_active?: boolean;
    },
    @Req() req: Request,
  ) {
    await this.auth.updateApiKey(id, (req as any).userId, body);
    return { code: 200, message: '已更新' };
  }

  @UseGuards(AuthGuard)
  @Delete('user/api-keys/:id')
  async deleteKey(@Param('id') id: string, @Req() req: Request) {
    await this.auth.deleteApiKey(id, (req as any).userId);
    return { code: 200, message: '已删除' };
  }
}
