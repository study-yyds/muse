import { authFetch } from "@/services/api";
import { useState, useEffect } from "react";

interface KeyInfo {
  id: string;
  name: string;
  model_name: string;
  usage: string;
  source: "platform" | "custom";
}

interface Props {
  usage: "chat" | "image";
  // 选中值：平台模型名（如 deepseek-v4-flash）、`custom:<keyId>`，或 ""（智能默认）
  value?: string;
  onChange: (model: string, keyId?: string) => void;
  className?: string;
  // 是否显示"智能（默认）"选项（值 ""，由后端按场景自动选模型）
  allowAuto?: boolean;
}

const PLATFORM_MODELS = {
  chat: [
    { name: "deepseek-v4-flash", label: "DeepSeek V4 Flash（平台）" },
    { name: "deepseek-v4-pro", label: "DeepSeek V4 Pro（平台）" },
    { name: "qwen3.7-plus", label: "千问 Qwen3.7 Plus（平台）" },
  ],
  image: [
    { name: "doubao-seedream-5-0-260128", label: "豆包 Seedream（平台）" },
    { name: "qwen-image-max", label: "千问图像 Max（平台）" },
  ],
};

/** 自定义 Key 的选中值（用 keyId 而非 model_name，避免同名 Key 选择歧义） */
export function customKeyValue(keyId: string): string {
  return `custom:${keyId}`;
}

export function ModelSelector({ usage, value, onChange, className, allowAuto }: Props) {
  const [customKeys, setCustomKeys] = useState<KeyInfo[]>([]);

  useEffect(() => {
    const token = localStorage.getItem("token");
    authFetch("/api/user/api-keys", {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.json())
      .then((json) => {
        const keys = (json.data || [])
          .filter((k: any) => k.usage === usage || k.usage === "both")
          .map((k: any) => ({
            id: k.id,
            name: k.name,
            model_name: k.model_name,
            usage: k.usage,
            source: "custom" as const,
          }));
        setCustomKeys(keys);
      })
      .catch(() => {});
  }, [usage]);

  const platformModels = PLATFORM_MODELS[usage] || [];

  return (
    <select
      value={value || ""}
      onChange={(e) => {
        const val = e.target.value;
        if (val === "") {
          onChange("", undefined); // 智能默认：由后端按场景自动选模型
        } else if (val.startsWith("custom:")) {
          const key = customKeys.find((k) => customKeyValue(k.id) === val);
          onChange(key?.model_name ?? "", key?.id);
        } else {
          onChange(val, undefined);
        }
      }}
      className={className || "text-xs rounded border border-border bg-background px-2 py-1"}
    >
      {allowAuto && (
        <option value="">智能（默认）</option>
      )}
      <optgroup label="—— 平台内置 ——">
        {platformModels.map((m) => (
          <option key={m.name} value={m.name}>
            {m.label}
          </option>
        ))}
      </optgroup>
      {customKeys.length > 0 && (
        <optgroup label="—— 我的 Key ——">
          {customKeys.map((k) => (
            <option key={k.id} value={customKeyValue(k.id)}>
              {k.name}（{k.model_name}）
            </option>
          ))}
        </optgroup>
      )}
    </select>
  );
}
