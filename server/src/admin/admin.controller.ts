import {
  Controller,
  Get,
  Patch,
  Param,
  Query,
  Body,
  UseGuards,
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
    const data = await this.admin.listUsers(
      page ? parseInt(page) : 1,
      pageSize ? parseInt(pageSize) : 20,
    );
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
    const data = await this.admin.getUserUsage(
      userId,
      months ? parseInt(months) : 6,
    );
    return { code: 200, data };
  }
}
