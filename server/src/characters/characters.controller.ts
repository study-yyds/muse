import { Controller, Get, Post, Patch, Delete, Param, Body, UseGuards } from "@nestjs/common";
import { CharactersService } from "./characters.service";
import { AuthGuard } from "../auth/auth.guard";
import { BookOwnerGuard } from "../auth/book-owner.guard";

@UseGuards(AuthGuard, BookOwnerGuard)
@Controller("api/books/:bookId/characters")
export class CharactersController {
  constructor(private readonly chars: CharactersService) {}

  @Get()
  async list(@Param("bookId") bookId: string) {
    const data = await this.chars.list(bookId);
    return { code: 200, data };
  }

  @Post()
  async create(@Param("bookId") bookId: string, @Body() body: any) {
    const data = await this.chars.create(bookId, body);
    return { code: 201, data };
  }

  @Patch(":charId")
  async update(@Param("bookId") bookId: string, @Param("charId") charId: string, @Body() body: any) {
    try {
      await this.chars.update(charId, body, bookId);
      return { code: 200, message: "已更新" };
    } catch (e: any) {
      return { code: 403, message: e.message };
    }
  }

  @Delete(":charId")
  async delete(@Param("charId") charId: string) {
    await this.chars.delete(charId);
    return { code: 200, message: "已删除" };
  }

  // 角色关系
  @Get(":charId/relations")
  async listRelations(@Param("charId") charId: string) {
    const data = await this.chars.listRelations(charId);
    return { code: 200, data };
  }

  @Post(":charId/relations")
  async addRelation(@Param("charId") charId: string, @Body() body: { target_char_id: string; relation_type: string; description?: string }) {
    const data = await this.chars.addRelation(charId, body);
    return { code: 201, data };
  }

  @Delete(":charId/relations/:relationId")
  async deleteRelation(@Param("relationId") relationId: string) {
    await this.chars.deleteRelation(relationId);
    return { code: 200, message: "已删除" };
  }
}
