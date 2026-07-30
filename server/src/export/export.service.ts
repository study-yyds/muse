import { Injectable } from '@nestjs/common';
import { eq, asc } from 'drizzle-orm';
import { Response } from 'express';
import { getDb, schema } from '../database/connection';
import { marked } from 'marked';

@Injectable()
export class ExportService {
  async export(res: Response, bookId: string, format: string) {
    const db = getDb();

    // 获取作品信息
    const [book] = await db
      .select()
      .from(schema.books)
      .where(eq(schema.books.book_id, bookId))
      .limit(1);
    if (!book) return res.status(404).json({ message: '作品不存在' });

    // 获取章节
    const chapters = await db
      .select()
      .from(schema.chapters)
      .where(eq(schema.chapters.book_id, bookId))
      .orderBy(asc(schema.chapters.sort_order));

    // 获取角色
    const characters = await db
      .select()
      .from(schema.characters)
      .where(eq(schema.characters.book_id, bookId));

    // 获取世界观
    const [world] = await db
      .select()
      .from(schema.world_settings)
      .where(eq(schema.world_settings.book_id, bookId));

    // 获取大纲
    const [outline] = await db
      .select()
      .from(schema.outlines)
      .where(eq(schema.outlines.book_id, bookId));
    const outlineChapters = outline
      ? await db
          .select()
          .from(schema.outline_chapters)
          .where(eq(schema.outline_chapters.outline_id, outline.outline_id))
          .orderBy(asc(schema.outline_chapters.sort_order))
      : [];

    switch (format) {
      case 'txt':
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${encodeURIComponent(book.title)}.txt"`,
        );
        res.write(
          this.buildTxt(
            book.title,
            chapters,
            characters,
            world,
            outlineChapters,
          ),
        );
        res.end();
        break;

      case 'html':
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${encodeURIComponent(book.title)}.html"`,
        );
        res.write(
          this.buildHtml(
            book.title,
            chapters,
            characters,
            world,
            outlineChapters,
          ),
        );
        res.end();
        break;

      case 'docx':
        res.setHeader(
          'Content-Type',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        );
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${encodeURIComponent(book.title)}.docx"`,
        );
        const { Document, Packer, Paragraph, TextRun, HeadingLevel } =
          await import('docx');
        const doc = new Document({
          styles: {
            default: { document: { run: { font: 'SimSun', size: 28 } } },
          },
          sections: [
            {
              properties: {},
              children: [
                new Paragraph({
                  text: book.title,
                  heading: HeadingLevel.TITLE,
                }),
                ...chapters.flatMap((ch) => [
                  new Paragraph({
                    text: ch.title,
                    heading: HeadingLevel.HEADING_1,
                  }),
                  ...ch.content
                    .split('\n')
                    .map(
                      (line) =>
                        new Paragraph({ children: [new TextRun(line)] }),
                    ),
                ]),
              ],
            },
          ],
        });
        const buffer = await Packer.toBuffer(doc);
        res.write(Buffer.from(buffer));
        res.end();
        break;

      default:
        res.status(400).json({ message: '不支持的格式' });
    }
  }

  private buildTxt(
    title: string,
    chapters: any[],
    characters: any[],
    world: any,
    outlineChapters: any[],
  ) {
    let out = `【${title}】\n\n`;
    for (const ch of chapters) {
      out += `\n${ch.title}\n${'='.repeat(20)}\n${ch.content}\n`;
    }
    out += `\n\n=== 角色设定 ===\n`;
    for (const c of characters) {
      out += `\n【${c.name}】${c.gender ?? ''} ${c.identity ?? ''}\n性格：${c.personality ?? ''}\n口头禅：${c.catchphrase ?? ''}\n背景：${c.backstory ?? ''}\n`;
    }
    out += `\n\n=== 世界观 ===\n`;
    if (world?.sections)
      for (const s of world.sections as any[])
        out += `\n[${s.name}]\n${s.content}\n`;
    out += `\n\n=== 大纲 ===\n`;
    for (const o of outlineChapters) out += `\n- ${o.title}：${o.summary}\n`;
    return out;
  }

  private buildHtml(
    title: string,
    chapters: any[],
    characters: any[],
    world: any,
    outlineChapters: any[],
  ) {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{max-width:800px;margin:0 auto;padding:40px;font:16px/1.8 system-ui;color:#333}h1{font-size:24px}h2{font-size:18px;margin-top:30px}.char{margin:10px 0;padding:10px;background:#f8f8f8;border-radius:4px}</style></head><body>
<h1>${title}</h1>
${chapters.map((ch) => `<h2>${ch.title}</h2>\n${marked.parse(ch.content)}`).join('\n')}
<hr><h2>角色设定</h2>
${characters.map((c) => `<div class="char"><strong>${c.name}</strong>${c.gender ? ' · ' + c.gender : ''}${c.identity ? ' · ' + c.identity : ''}<br>${c.personality ?? ''}</div>`).join('\n')}
<hr><h2>世界观</h2>
${world?.sections ? (world.sections as any[]).map((s) => `<h3>${s.name}</h3><p>${s.content}</p>`).join('\n') : ''}
<hr><h2>大纲</h2><ul>${outlineChapters.map((o) => `<li>${o.title}：${o.summary}</li>`).join('\n')}</ul>
</body></html>`;
  }
}
