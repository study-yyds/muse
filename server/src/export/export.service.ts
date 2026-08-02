import { Injectable } from '@nestjs/common';
import { eq, asc } from 'drizzle-orm';
import { Response } from 'express';
import { getDb, schema } from '../database/connection';
import { marked } from 'marked';
import crypto from 'crypto';

// archiver v8 ESM — 用 require 兼容
const archiver = require('archiver');

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

      case 'epub':
        res.setHeader('Content-Type', 'application/epub+zip');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${encodeURIComponent(book.title)}.epub"`,
        );
        await this.buildEpub(res, book.title, chapters, characters, world, outlineChapters);
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

  private esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  private async buildEpub(
    res: Response,
    title: string,
    chapters: any[],
    characters: any[],
    world: any,
    outlineChapters: any[],
  ) {
    const esc = this.esc.bind(this);

    // EPUB 章节 XHTML
    const chapterFiles = chapters.map((ch, i) => ({
      id: `chapter${i + 1}`,
      title: ch.title,
      html: `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-CN">
<head><title>${esc(ch.title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body><h2>${esc(ch.title)}</h2>${ch.content.split('\n').map((l: string) => `<p>${esc(l)}</p>`).join('\n')}</body></html>`,
    }));

    // 角色页
    const charHtml = characters.map((c) =>
      `<div class="char"><h3>${esc(c.name)}</h3><p>${esc(c.gender ?? '')} · ${esc(c.identity ?? '')}</p><p>${esc(c.personality ?? '')}</p></div>`
    ).join('\n');

    // content.opf
    const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>${esc(title)}</dc:title>
    <dc:creator>Muse User</dc:creator>
    <dc:language>zh-CN</dc:language>
    <dc:identifier id="bookid">urn:uuid:${crypto.randomUUID()}</dc:identifier>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="css" href="style.css" media-type="text/css"/>
    ${chapterFiles.map((cf) => `<item id="${cf.id}" href="${cf.id}.xhtml" media-type="application/xhtml+xml"/>`).join('\n')}
    <item id="chars" href="characters.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx">
    ${chapterFiles.map((cf) => `<itemref idref="${cf.id}"/>`).join('\n')}
    <itemref idref="chars"/>
  </spine>
</package>`;

    // toc.ncx
    const ncx = `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="urn:uuid:${crypto.randomUUID()}"/></head>
  <docTitle><text>${esc(title)}</text></docTitle>
  <navMap>
    ${chapterFiles.map((cf, i) => `<navPoint id="nav${i + 1}" playOrder="${i + 1}"><navLabel><text>${esc(cf.title)}</text></navLabel><content src="${cf.id}.xhtml"/></navPoint>`).join('\n')}
    <navPoint id="navChars" playOrder="${chapterFiles.length + 1}"><navLabel><text>角色设定</text></navLabel><content src="characters.xhtml"/></navPoint>
  </navMap>
</ncx>`;

    const css = `body { font-family: serif; line-height: 1.8; margin: 1em; } h2 { text-align: center; margin: 1em 0; } .char { margin: 0.5em 0; padding: 0.5em; border-left: 3px solid #ccc; }`;

    const container = `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

    const charactersXhtml = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-CN">
<head><title>角色设定</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body><h2>角色设定</h2>${charHtml}</body></html>`;

    const archive = archiver('zip', { store: false });
    archive.pipe(res);

    // EPUB spec: 第一个文件必须是 mimetype，且不压缩
    archive.append('application/epub+zip', { store: true, name: 'mimetype' });
    archive.append(container, { name: 'META-INF/container.xml' });
    archive.append(opf, { name: 'OEBPS/content.opf' });
    archive.append(ncx, { name: 'OEBPS/toc.ncx' });
    archive.append(css, { name: 'OEBPS/style.css' });
    archive.append(charactersXhtml, { name: 'OEBPS/characters.xhtml' });
    for (const cf of chapterFiles) {
      archive.append(cf.html, { name: `OEBPS/${cf.id}.xhtml` });
    }

    await archive.finalize();
  }

  private buildHtml(
    title: string,
    chapters: any[],
    characters: any[],
    world: any,
    outlineChapters: any[],
  ) {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${this.esc(title)}</title>
<style>body{max-width:800px;margin:0 auto;padding:40px;font:16px/1.8 system-ui;color:#333}h1{font-size:24px}h2{font-size:18px;margin-top:30px}.char{margin:10px 0;padding:10px;background:#f8f8f8;border-radius:4px}</style></head><body>
<h1>${this.esc(title)}</h1>
${chapters.map((ch) => `<h2>${this.esc(ch.title)}</h2>\n${marked.parse(this.esc(ch.content))}`).join('\n')}
<hr><h2>角色设定</h2>
${characters.map((c) => `<div class="char"><strong>${this.esc(c.name)}</strong>${c.gender ? ' · ' + this.esc(c.gender) : ''}${c.identity ? ' · ' + this.esc(c.identity) : ''}<br>${this.esc(c.personality ?? '')}</div>`).join('\n')}
<hr><h2>世界观</h2>
${world?.sections ? (world.sections as any[]).map((s) => `<h3>${this.esc(s.name)}</h3><p>${this.esc(s.content)}</p>`).join('\n') : ''}
<hr><h2>大纲</h2><ul>${outlineChapters.map((o) => `<li>${this.esc(o.title)}：${this.esc(o.summary)}</li>`).join('\n')}</ul>
</body></html>`;
  }
}
