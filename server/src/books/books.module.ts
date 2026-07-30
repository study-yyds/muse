import { Module } from '@nestjs/common';
import { BooksController } from './books.controller';
import { BooksStatsController } from './books-stats.controller';
import { BooksService } from './books.service';

@Module({
  controllers: [BooksController, BooksStatsController],
  providers: [BooksService],
})
export class BooksModule {}
