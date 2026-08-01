import { Controller, Get, Put, Param, Body, UseGuards } from "@nestjs/common";
import { WorldService } from "./world.service";
import { AuthGuard } from "../auth/auth.guard";
import { BookOwnerGuard } from "../auth/book-owner.guard";

@UseGuards(AuthGuard, BookOwnerGuard)
@Controller("api/books/:bookId/world-setting")
export class WorldController {
  constructor(private readonly world: WorldService) {}

  @Get()
  async get(@Param("bookId") bookId: string) {
    const data = await this.world.get(bookId);
    return { code: 200, data: data ?? { sections: [] } };
  }

  @Put()
  async save(@Param("bookId") bookId: string, @Body("sections") sections: any[]) {
    await this.world.save(bookId, sections);
    return { code: 200, message: "已保存" };
  }
}
