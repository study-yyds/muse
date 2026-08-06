import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Req,
  Param,
  UseGuards,
} from '@nestjs/common';
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
    @Body() body: { name: string; api_key: string; base_url: string; model_name: string; usage: string },
    @Req() req: Request,
  ) {
    const data = await this.auth.createApiKey((req as any).userId, body);
    return { code: 201, data };
  }

  @UseGuards(AuthGuard)
  @Put('user/api-keys/:id')
  async updateKey(
    @Param('id') id: string,
    @Body() body: { name?: string; api_key?: string; base_url?: string; model_name?: string; usage?: string; is_active?: boolean },
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
