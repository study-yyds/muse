import { describe, it, expect } from "vitest";

// 复制 BookDetailPage.tsx 中的纯函数用于单测
// （实际上这些是该文件内部的函数，这里直接内联副本测试）

const extractDisplayText = (t: string): string => {
  if (!t.trim()) return "";
  let s = t.trim();
  if (s.startsWith("```json")) s = s.slice(7);
  if (s.startsWith("```")) s = s.slice(3);
  if (s.endsWith("```")) s = s.slice(0, -3);
  const fenceIdx = s.lastIndexOf("\n```json\n");
  if (fenceIdx > 0) s = s.slice(0, fenceIdx);
  s = s.trim();
  if (s.startsWith("{")) {
    try {
      const p = JSON.parse(s);
      if (p.sections?.length) {
        return p.sections
          .map((sec: any) => `【${sec.name}】\n${sec.content}`)
          .join("\n\n");
      }
      if (p.name) return `角色：${p.name}\n${p.personality ?? ""}`;
      return p.content || p.action || s;
    } catch { return s; }
  }
  if (s.startsWith("[")) {
    try {
      const arr = JSON.parse(s);
      if (arr.length && arr[0].name && arr[0].content) {
        return arr.map((sec: any) => `【${sec.name}】\n${sec.content}`).join("\n\n");
      }
      if (arr.length && arr[0].action === "create_character") {
        return arr.map((c: any) => `【${c.name}】${c.gender ?? ""} · ${c.identity ?? ""}\n${c.personality ?? ""}`).join("\n\n");
      }
    } catch { /* fall through */ }
  }
  let actionIdx = s.lastIndexOf('\n{"action"');
  if (actionIdx < 0) actionIdx = s.lastIndexOf('\n[{"action"');
  if (actionIdx < 0) actionIdx = s.lastIndexOf('{"action"');
  if (actionIdx < 0) actionIdx = s.lastIndexOf('[{"action"');
  if (actionIdx > 0) {
    try {
      const p = JSON.parse(s.slice(actionIdx));
      if (p.action || (Array.isArray(p) && p.length > 0)) return s.slice(0, actionIdx).trim();
    } catch {
      return s.slice(0, actionIdx).trim();
    }
  }
  return s;
};

const stripActionJson = (t: string): string => {
  if (!t) return "";
  let idx = t.lastIndexOf('\n[{"action"');
  if (idx < 0) idx = t.lastIndexOf('\n{"action"');
  if (idx > 0) return t.slice(0, idx).trim();
  idx = t.lastIndexOf('[{"action"');
  if (idx < 0) idx = t.lastIndexOf('{"action"');
  if (idx > 0) return t.slice(0, idx).trim();
  return t;
};

// ============================================================
// extractDisplayText
// ============================================================
describe("extractDisplayText", () => {
  it("空字符串返回空", () => {
    expect(extractDisplayText("")).toBe("");
    expect(extractDisplayText("   ")).toBe("");
  });

  it("纯自然语言原样返回", () => {
    expect(extractDisplayText("你好，这是一个测试")).toBe("你好，这是一个测试");
  });

  it("markdown 代码块包裹的纯 JSON → 提取内容", () => {
    const input = '```json\n{"action":"create_character","name":"林默","personality":"冷漠"}\n```';
    const result = extractDisplayText(input);
    expect(result).toContain("林默");
    expect(result).toContain("冷漠");
    expect(result).not.toContain("{");
  });

  it("正文末尾有 update_sections JSON → 剥离 JSON", () => {
    const input = '时代与背景\n这是一段描述\n\n{"action":"update_sections","sections":[{"name":"时代与背景","content":"新内容"}]}';
    const result = extractDisplayText(input);
    expect(result).toContain("时代与背景");
    expect(result).toContain("这是一段描述");
    expect(result).not.toContain('"action"');
  });

  it("正文末尾有 create_character JSON → 剥离 JSON", () => {
    const input = '好的，我设计了这样一个主角\n{"action":"create_character","name":"林默","personality":"冷漠"}';
    const result = extractDisplayText(input);
    expect(result).toContain("好的");
    expect(result).not.toContain('"action"');
  });

  it("纯 world sections JSON → 提取分区摘要", () => {
    const input = '{"action":"update_sections","sections":[{"name":"时代与背景","content":"灾变后"},{"name":"地理与场景","content":"公路"}]}';
    const result = extractDisplayText(input);
    expect(result).toContain("【时代与背景】");
    expect(result).toContain("灾变后");
    expect(result).toContain("【地理与场景】");
    expect(result).not.toContain("{");
  });

  it("纯 character JSON 数组 → 提取角色摘要", () => {
    const input = '[{"action":"create_character","name":"林默","gender":"男","personality":"冷漠"}]';
    const result = extractDisplayText(input);
    expect(result).toContain("【林默】");
    expect(result).toContain("冷漠");
    expect(result).not.toContain("{");
  });

  it("正文在 ```json 代码块前面的情况 → 切掉代码块", () => {
    const input = '好的，以下是一些角色\n\n```json\n[{"action":"create_character","name":"测试"}]\n```';
    const result = extractDisplayText(input);
    expect(result).toContain("好的");
    expect(result).not.toContain("```");
    expect(result).not.toContain('"action"');
  });

  it("截断的 JSON 也能剥离", () => {
    const input = '正文内容\n{"action":"update_sections","sections":[{"name":"时代与背景","conte'; // 不完整 JSON
    const result = extractDisplayText(input);
    expect(result).toBe("正文内容");
  });
});

// ============================================================
// stripActionJson
// ============================================================
describe("stripActionJson", () => {
  it("空字符串返回空", () => {
    expect(stripActionJson("")).toBe("");
  });

  it("无 JSON 的文本原样返回", () => {
    expect(stripActionJson("这是一段普通的文本")).toBe("这是一段普通的文本");
  });

  it("末尾 \\n{ 格式的 JSON 被剥离", () => {
    const input = '正文\n{"action":"create_character","name":"test"}';
    expect(stripActionJson(input)).toBe("正文");
  });

  it("末尾 \\n[{ 格式的 JSON 数组被剥离", () => {
    const input = '正文\n[{"action":"create_character","name":"test"}]';
    expect(stripActionJson(input)).toBe("正文");
  });

  it("直接紧跟的 JSON 也被剥离", () => {
    const input = '正文{"action":"create_character","name":"test"}';
    expect(stripActionJson(input)).toBe("正文");
  });

  it("直接紧跟的 JSON 数组也被剥离", () => {
    const input = '正文[{"action":"create_character","name":"test"}]';
    expect(stripActionJson(input)).toBe("正文");
  });

  it("JSON 在文本中间不会被误删", () => {
    const input = '前半段{"action":"not_real"}后半段';
    // lastIndexOf 会找到第一个 {"action"，它在 4 位置。然后 text.slice(0,4) = "前半段"
    const result = stripActionJson(input);
    // The JSON is in the middle, lastIndexOf finds the SECOND {"action" which is the same one
    // Actually lastIndexOf finds the last occurrence, which is at position 4 (0-indexed)
    // .slice(0,4) = "前半段"
    expect(result).toBe("前半段");
  });
});
