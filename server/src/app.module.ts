import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth/auth.module';
import { BooksModule } from './books/books.module';
import { CharactersModule } from './characters/characters.module';
import { ChaptersModule } from './chapters/chapters.module';
import { WorldModule } from './world/world.module';
import { OutlineModule } from './outline/outline.module';
import { AiModule } from './ai/ai.module';
import { TemplatesModule } from './templates/templates.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    AuthModule,
    BooksModule,
    CharactersModule,
    ChaptersModule,
    WorldModule,
    OutlineModule,
    AiModule,
    TemplatesModule,
  ],
})
export class AppModule {}
