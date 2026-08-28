import {
  Controller,
  Get,
  Param,
  Query,
  Res,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ExportService } from './export.service';
import { AuthGuard } from '../auth/auth.guard';
import { BookOwnerGuard } from '../auth/book-owner.guard';

@UseGuards(AuthGuard, BookOwnerGuard)
@Controller('api/books/:bookId/export')
export class ExportController {
  constructor(private readonly e: ExportService) {}

  @Get()
  async export(
    @Param('bookId') bookId: string,
    @Query('format') format: string,
    @Res() res: Response,
    @Req() req: Request,
  ) {
    await this.e.export(res, bookId, format ?? 'txt', (req as any).userId);
  }
}
