import { Controller, Get, Param, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
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
  ) {
    await this.e.export(res, bookId, format ?? 'txt');
  }
}
