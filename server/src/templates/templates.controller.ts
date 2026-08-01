import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Query,
  Body,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { TemplatesService } from './templates.service';
import { AuthGuard } from '../auth/auth.guard';
import { AdminGuard } from '../auth/admin.guard';

@Controller('api/templates')
export class TemplatesController {
  constructor(private readonly tpl: TemplatesService) {}

  @Get()
  async list(
    @Query('type') type: string,
    @Query('category') category: string,
    @Req() req: Request,
  ) {
    await this.tpl.seedPresets();
    const userId = (req as any).userId; // 来自 AuthGuard（可选，公共接口不需强制登录）
    const data = await this.tpl.list({ type, category }, userId);
    return { code: 200, data };
  }

  // === 管理员端点（必须在 :id 之前定义）===

  @UseGuards(AuthGuard, AdminGuard)
  @Get('admin/all')
  async listAll(
    @Query('type') type: string,
    @Query('category') category: string,
  ) {
    await this.tpl.seedPresets();
    const data = await this.tpl.listAll({ type, category });
    return { code: 200, data };
  }

  @UseGuards(AuthGuard, AdminGuard)
  @Post('admin/create')
  async createPreset(
    @Body()
    body: {
      name: string;
      type: string;
      category: string;
      description?: string;
      data: any;
      is_preset?: boolean;
      is_public?: boolean;
    },
  ) {
    const data = await this.tpl.createPreset(body);
    return { code: 201, data };
  }

  @UseGuards(AuthGuard, AdminGuard)
  @Patch('admin/:id')
  async updatePreset(
    @Param('id') id: string,
    @Body()
    body: {
      name?: string;
      type?: string;
      category?: string;
      description?: string;
      data?: any;
      is_preset?: boolean;
      is_public?: boolean;
    },
  ) {
    await this.tpl.update(id, body);
    return { code: 200, message: '已更新' };
  }

  @UseGuards(AuthGuard, AdminGuard)
  @Delete('admin/:id')
  async deleteAny(@Param('id') id: string) {
    await this.tpl.delete(id);
    return { code: 200, message: '已删除' };
  }

  // === 普通用户端点 ===

  @Get(':id')
  async get(@Param('id') id: string, @Req() req: Request) {
    const userId = (req as any).userId;
    const data = await this.tpl.get(id, userId);
    return data ? { code: 200, data } : { code: 404, message: '模板不存在' };
  }

  @UseGuards(AuthGuard)
  @Post()
  async create(
    @Body()
    body: {
      name: string;
      type: string;
      category: string;
      description?: string;
      data: any;
      is_public?: boolean;
    },
    @Req() req: Request,
  ) {
    const data = await this.tpl.create((req as any).userId, body);
    return { code: 201, data };
  }

  @UseGuards(AuthGuard)
  @Delete(':id')
  async delete(@Param('id') id: string, @Req() req: Request) {
    try {
      await this.tpl.delete(id, (req as any).userId);
      return { code: 200, message: '已删除' };
    } catch (e: any) {
      return { code: 403, message: e.message };
    }
  }
}
