import { Injectable } from '@nestjs/common';
import { eq, asc } from 'drizzle-orm';
import { Response } from 'express';
import { getDb, schema } from '../database/connection';
import { marked } from 'marked';
import crypto from 'crypto';
import JSZip from 'jszip';

@Injectable()
export class ExportService {
  async export(res: Response, bookId: string, format: string, userId?: string) {
    const db = getDb();

    // 获取作品信息
    const [book] = await db
      .select()
      .from(schema.books)
      .where(eq(schema.books.book_id, bookId))
      .limit(1);
    if (!book) return res.status(404).json({ message: '作品不存在' });

    // 审计日志：记录每次导出（失败不阻断导出流程）
    if (userId) {
      try {
        await db.insert(schema.export_records).values({
          book_id: bookId,
          user_id: userId,
          format: format ?? 'txt',
          include_settings: true,
        });
      } catch (e: any) {
        console.error('[export] record failed:', e.message);
      }
    }

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

    // 分幕结构
    const acts = outline
      ? await db
          .select()
          .from(schema.outline_act_chapters)
          .where(eq(schema.outline_act_chapters.outline_id, outline.outline_id))
          .orderBy(asc(schema.outline_act_chapters.sort_order))
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
            acts,
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
            acts,
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
        await this.buildEpub(
          res,
          book.title,
          chapters,
          characters,
          world,
          outlineChapters,
          acts,
        );
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
    acts: any[],
  ) {
    let out = `【${title}】\n\n`;
    for (const ch of chapters) {
      out += `\n${ch.title}\n${'='.repeat(20)}\n${ch.content}\n`;
    }
    out += `\n\n=== 角色设定 ===\n`;
    for (const c of characters) {
      out += `\n【${c.name}】${c.gender ?? ''} ${c.identity ?? ''}\n性格：${c.personality ?? ''}\n口头禅：${c.catchphrase ?? ''}\n背景：${c.backstory ?? ''}\n`;
      const customs = (c.custom_fields as any[]) ?? [];
      if (customs.length > 0) {
        out += `自定义字段：${customs
          .map((f) => `${f.key}=${f.value}`)
          .join('，')}\n`;
      }
    }
    out += `\n\n=== 世界观 ===\n`;
    if (world?.sections)
      for (const s of world.sections as any[])
        out += `\n[${s.name}]\n${s.content}\n`;
    out += this.buildOutlineTxt(outlineChapters, acts);
    return out;
  }

  /** 大纲文本：按分幕分组输出，未分幕节点归入「未分幕」 */
  private buildOutlineTxt(outlineChapters: any[], acts: any[]): string {
    let out = `\n\n=== 大纲 ===\n`;
    if (acts.length === 0) {
      for (const o of outlineChapters) out += `\n- ${o.title}：${o.summary}\n`;
      return out;
    }
    const nodeById = new Map(outlineChapters.map((o) => [o.id, o]));
    const byAct = new Map<string, any[]>();
    for (const ac of acts) {
      const list = byAct.get(ac.act_name) ?? [];
      const node = nodeById.get(ac.chapter_id);
      if (node) list.push(node);
      byAct.set(ac.act_name, list);
    }
    for (const [actName, nodes] of byAct) {
      out += `\n【${actName}】\n`;
      for (const o of nodes) out += `- ${o.title}：${o.summary}\n`;
    }
    const inActs = new Set(acts.map((a) => a.chapter_id));
    const unassigned = outlineChapters.filter((o) => !inActs.has(o.id));
    if (unassigned.length > 0) {
      out += `\n【未分幕】\n`;
      for (const o of unassigned) out += `- ${o.title}：${o.summary}\n`;
    }
    return out;
  }

  private esc(s: string): string {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  private async buildEpub(
    res: Response,
    title: string,
    chapters: any[],
    characters: any[],
    world: any,
    outlineChapters: any[],
    acts: any[],
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
<body><h2>${esc(ch.title)}</h2>${ch.content
        .split('\n')
        .map((l: string) => `<p>${esc(l)}</p>`)
        .join('\n')}</body></html>`,
    }));

    // 角色页（含自定义字段）
    const charHtml = characters
      .map((c) => {
        const customs = (c.custom_fields as any[]) ?? [];
        return `<div class="char"><h3>${esc(c.name)}</h3><p>${esc(c.gender ?? '')} · ${esc(c.identity ?? '')}</p><p>${esc(c.personality ?? '')}</p>${customs.length ? `<p>自定义字段：${customs.map((f) => `${esc(f.key)}=${esc(f.value)}`).join('，')}</p>` : ''}</div>`;
      })
      .join('\n');

    // 设定页（世界观 + 分幕大纲）——与 TXT 导出保持一致
    const worldSections = (world?.sections as any[]) || [];
    const outlineBlocks: string[] = [];
    if (acts.length > 0) {
      const nodeById = new Map(outlineChapters.map((o) => [o.id, o]));
      const byAct = new Map<string, any[]>();
      for (const ac of acts) {
        const list = byAct.get(ac.act_name) ?? [];
        const node = nodeById.get(ac.chapter_id);
        if (node) list.push(node);
        byAct.set(ac.act_name, list);
      }
      for (const [actName, nodes] of byAct) {
        outlineBlocks.push(`<h3>${esc(actName)}</h3>`);
        for (const o of nodes)
          outlineBlocks.push(`<p>${esc(o.title)}：${esc(o.summary || '')}</p>`);
      }
      const inActs = new Set(acts.map((a) => a.chapter_id));
      const unassigned = outlineChapters.filter((o) => !inActs.has(o.id));
      if (unassigned.length > 0) {
        outlineBlocks.push(`<h3>未分幕</h3>`);
        for (const o of unassigned)
          outlineBlocks.push(`<p>${esc(o.title)}：${esc(o.summary || '')}</p>`);
      }
    } else {
      for (const o of outlineChapters)
        outlineBlocks.push(
          `<h3>${esc(o.title)}</h3><p>${esc(o.summary || '')}</p>`,
        );
    }
    const settingsHtml = [
      '<h2>世界观设定</h2>',
      ...worldSections.map(
        (s) => `<h3>${esc(s.name)}</h3><p>${esc(s.content || '')}</p>`,
      ),
      '<h2>故事大纲</h2>',
      ...outlineBlocks,
    ].join('\n');

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
    <item id="settings" href="settings.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx">
    ${chapterFiles.map((cf) => `<itemref idref="${cf.id}"/>`).join('\n')}
    <itemref idref="chars"/>
    <itemref idref="settings"/>
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
    <navPoint id="navSettings" playOrder="${chapterFiles.length + 2}"><navLabel><text>设定与大纲</text></navLabel><content src="settings.xhtml"/></navPoint>
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

    const zip = new JSZip();
    // EPUB spec: 第一个文件必须是 mimetype，不压缩
    zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
    zip.file('META-INF/container.xml', container);
    zip.file('OEBPS/content.opf', opf);
    zip.file('OEBPS/toc.ncx', ncx);
    zip.file('OEBPS/style.css', css);
    zip.file('OEBPS/characters.xhtml', charactersXhtml);
    zip.file(
      'OEBPS/settings.xhtml',
      `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-CN">
<head><title>设定与大纲</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body>${settingsHtml}</body></html>`,
    );
    for (const cf of chapterFiles) {
      zip.file(`OEBPS/${cf.id}.xhtml`, cf.html);
    }

    const buffer = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
    });
    res.write(Buffer.from(buffer));
    res.end();
  }

  private buildHtml(
    title: string,
    chapters: any[],
    characters: any[],
    world: any,
    outlineChapters: any[],
    acts: any[],
  ) {
    const charBlocks = characters
      .map((c) => {
        const customs = (c.custom_fields as any[]) ?? [];
        return `<div class="char"><strong>${this.esc(c.name)}</strong>${c.gender ? ' · ' + this.esc(c.gender) : ''}${c.identity ? ' · ' + this.esc(c.identity) : ''}<br>${this.esc(c.personality ?? '')}${customs.length ? `<br>自定义字段：${customs.map((f) => `${this.esc(f.key)}=${this.esc(f.value)}`).join('，')}` : ''}</div>`;
      })
      .join('\n');
    const outlineHtml = this.buildOutlineHtml(outlineChapters, acts);
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${this.esc(title)}</title>
<style>body{max-width:800px;margin:0 auto;padding:40px;font:16px/1.8 system-ui;color:#333}h1{font-size:24px}h2{font-size:18px;margin-top:30px}h3{margin-top:20px}.char{margin:10px 0;padding:10px;background:#f8f8f8;border-radius:4px}</style></head><body>
<h1>${this.esc(title)}</h1>
${chapters.map((ch) => `<h2>${this.esc(ch.title)}</h2>\n${marked.parse(this.esc(ch.content))}`).join('\n')}
<hr><h2>角色设定</h2>
${charBlocks}
<hr><h2>世界观</h2>
${world?.sections ? (world.sections as any[]).map((s) => `<h3>${this.esc(s.name)}</h3><p>${this.esc(s.content)}</p>`).join('\n') : ''}
<hr><h2>大纲</h2>${outlineHtml}
</body></html>`;
  }

  /** 大纲 HTML：按分幕分组输出 */
  private buildOutlineHtml(outlineChapters: any[], acts: any[]): string {
    if (acts.length === 0) {
      return `<ul>${outlineChapters.map((o) => `<li>${this.esc(o.title)}：${this.esc(o.summary)}</li>`).join('\n')}</ul>`;
    }
    const nodeById = new Map(outlineChapters.map((o) => [o.id, o]));
    const byAct = new Map<string, any[]>();
    for (const ac of acts) {
      const list = byAct.get(ac.act_name) ?? [];
      const node = nodeById.get(ac.chapter_id);
      if (node) list.push(node);
      byAct.set(ac.act_name, list);
    }
    let out = '';
    for (const [actName, nodes] of byAct) {
      out += `<h3>${this.esc(actName)}</h3><ul>${nodes.map((o) => `<li>${this.esc(o.title)}：${this.esc(o.summary)}</li>`).join('\n')}</ul>`;
    }
    const inActs = new Set(acts.map((a) => a.chapter_id));
    const unassigned = outlineChapters.filter((o) => !inActs.has(o.id));
    if (unassigned.length > 0) {
      out += `<h3>未分幕</h3><ul>${unassigned.map((o) => `<li>${this.esc(o.title)}：${this.esc(o.summary)}</li>`).join('\n')}</ul>`;
    }
    return out;
  }
}
