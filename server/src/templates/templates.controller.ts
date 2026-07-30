import {
  Controller,
  Get,
  Post,
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

@Controller('api/templates')
export class TemplatesController {
  constructor(private readonly tpl: TemplatesService) {}

  @Get()
  async list(@Query('type') type: string, @Query('category') category: string) {
    // 每次查模板前自动播种
    await this.tpl.seedPresets();
    const data = await this.tpl.list({ type, category });
    return { code: 200, data };
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    const data = await this.tpl.get(id);
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
    },
    @Req() req: Request,
  ) {
    const data = await this.tpl.create((req as any).userId, body);
    return { code: 201, data };
  }

  @UseGuards(AuthGuard)
  @Delete(':id')
  async delete(@Param('id') id: string) {
    await this.tpl.delete(id);
    return { code: 200, message: '已删除' };
  }
}
