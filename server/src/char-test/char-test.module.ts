import { Module } from '@nestjs/common';
import { CharTestController } from './char-test.controller';
import { CharTestService } from './char-test.service';

@Module({
  controllers: [CharTestController],
  providers: [CharTestService],
})
export class CharTestModule {}
