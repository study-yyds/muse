import { Controller, Get, Post, Body, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { AuthService } from './auth.service';
import { AuthGuard } from './auth.guard';

@Controller('api')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('auth/send-code')
  async sendCode(@Body('phone_number') phone: string) {
    const result = await this.auth.sendCode(phone);
    return { code: 200, message: '验证码已发送', data: result };
  }

  @Post('auth/login')
  async login(@Body('phone_number') phone: string, @Body('code') code: string) {
    try {
      const result = await this.auth.login(phone, code);
      return { code: 200, data: result };
    } catch {
      return { code: 401, message: '验证码错误或已过期' };
    }
  }

  @UseGuards(AuthGuard)
  @Get('user/profile')
  async profile(@Req() req: Request) {
    const user = await this.auth.getProfile((req as any).userId);
    return user
      ? { code: 200, data: user }
      : { code: 404, message: '用户不存在' };
  }
}
