import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  UseGuards,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { BillingService } from './billing.service';
import { AuthGuard } from '../auth/auth.guard';

@UseGuards(AuthGuard)
@Controller('api/billing')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  /** 创建订单（待支付） */
  @Post('orders')
  async createOrder(
    @Body() body: { plan_id: string },
    @Req() req: Request,
  ) {
    const order = await this.billing.createOrder(
      (req as any).userId,
      body.plan_id,
    );
    return { code: 200, data: order };
  }

  /** 模拟支付成功（真实支付接入后替换为网关回调） */
  @Post('orders/:orderId/pay-mock')
  async payMockOrder(
    @Param('orderId') orderId: string,
    @Req() req: Request,
  ) {
    const data = await this.billing.payMockOrder(
      (req as any).userId,
      orderId,
    );
    return { code: 200, data };
  }

  /** 取消订单 */
  @Post('orders/:orderId/cancel')
  async cancelOrder(
    @Param('orderId') orderId: string,
    @Req() req: Request,
  ) {
    const data = await this.billing.cancelOrder((req as any).userId, orderId);
    return { code: 200, data };
  }

  /** 我的订单记录 */
  @Get('orders')
  async listOrders(@Req() req: Request) {
    const data = await this.billing.listOrders((req as any).userId);
    return { code: 200, data };
  }
}
