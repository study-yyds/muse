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
  value?: string;       // selected model name
  onChange: (model: string, keyId?: string) => void;
  className?: string;
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

export function ModelSelector({ usage, value, onChange, className }: Props) {
  const [customKeys, setCustomKeys] = useState<KeyInfo[]>([]);

  useEffect(() => {
    const token = localStorage.getItem("token");
    fetch("/api/user/api-keys", {
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
        const custom = customKeys.find((k) => k.model_name === val);
        onChange(val, custom?.id);
      }}
      className={className || "text-xs rounded border border-border bg-background px-2 py-1"}
    >
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
            <option key={k.id} value={k.model_name}>
              {k.name}（{k.model_name}）
            </option>
          ))}
        </optgroup>
      )}
    </select>
  );
}
