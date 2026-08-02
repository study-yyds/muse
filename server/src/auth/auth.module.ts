import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthGuard } from './auth.guard';
import { AdminGuard } from './admin.guard';
import { BookOwnerGuard } from './book-owner.guard';
import { RateLimitGuard } from './rate-limit.guard';

@Global()
@Module({
  imports: [
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow('JWT_SECRET'),
        signOptions: { expiresIn: '12h' },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService, AuthGuard, AdminGuard, BookOwnerGuard,
    { provide: 'AI_RATE_LIMIT', useValue: new RateLimitGuard(10, 60_000) },
  ],
  exports: [AuthService, JwtModule, AuthGuard, AdminGuard, BookOwnerGuard, 'AI_RATE_LIMIT'],
})
export class AuthModule {}
