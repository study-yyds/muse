/**
 * 默认生成模型（用户级设置，localStorage 持久化）。
 * 没有单独模型选择器的 AI 功能（整章生成、章纲生成等）统一使用此设置；
 * 留空 = 智能默认（后端按场景选模型）。值语义与 ModelSelector 一致：
 * keyId 存在时 model 为该 Key 的模型名。
 */
const DEFAULT_MODEL_KEY = "muse_default_model";
const DEFAULT_KEY_ID_KEY = "muse_default_key_id";

export function getDefaultModel(): { model: string; keyId?: string } {
  return {
    model: localStorage.getItem(DEFAULT_MODEL_KEY) ?? "",
    keyId: localStorage.getItem(DEFAULT_KEY_ID_KEY) ?? undefined,
  };
}

export function setDefaultModel(model: string, keyId?: string) {
  if (model) localStorage.setItem(DEFAULT_MODEL_KEY, model);
  else localStorage.removeItem(DEFAULT_MODEL_KEY);
  if (keyId) localStorage.setItem(DEFAULT_KEY_ID_KEY, keyId);
  else localStorage.removeItem(DEFAULT_KEY_ID_KEY);
}

/** 生成请求 body 的 model/key_id 字段（无默认值时为空对象） */
export function defaultModelBody(): {
  model?: string;
  key_id?: string;
} {
  const dm = getDefaultModel();
  return {
    ...(dm.model ? { model: dm.model } : {}),
    ...(dm.keyId ? { key_id: dm.keyId } : {}),
  };
}
