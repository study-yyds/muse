import {
  Controller,
  Get,
  Patch,
  Param,
  Query,
  Body,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { AdminService } from './admin.service';
import { AuthGuard } from '../auth/auth.guard';
import { AdminGuard } from '../auth/admin.guard';

@UseGuards(AuthGuard, AdminGuard)
@Controller('api/admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('users')
  async listUsers(
    @Query('page') page: string,
    @Query('pageSize') pageSize: string,
  ) {
    // 分页参数校验：NaN/负数/超大 pageSize 直接 400
    const p = page ? Number(page) : 1;
    const ps = pageSize ? Number(pageSize) : 20;
    if (
      !Number.isInteger(p) ||
      p < 1 ||
      !Number.isInteger(ps) ||
      ps < 1 ||
      ps > 100
    ) {
      throw new BadRequestException('分页参数无效');
    }
    const data = await this.admin.listUsers(p, ps);
    return { code: 200, data };
  }

  @Patch('users/:userId')
  async updateUser(
    @Param('userId') userId: string,
    @Body() body: { role?: string; status?: string; book_limit?: number },
  ) {
    const result = await this.admin.updateUser(userId, body);
    return { code: 200, ...result };
  }

  @Get('users/:userId/usage')
  async getUserUsage(
    @Param('userId') userId: string,
    @Query('months') months: string,
  ) {
    const m = months ? Number(months) : 6;
    if (!Number.isInteger(m) || m < 1 || m > 24) {
      throw new BadRequestException('months 参数无效（1-24）');
    }
    const data = await this.admin.getUserUsage(userId, m);
    return { code: 200, data };
  }

  // 平台总用量统计（全站 token 总量 + 按模型聚合）
  @Get('usage')
  async getPlatformUsage() {
    const data = await this.admin.getPlatformUsage();
    return { code: 200, data };
  }
}
