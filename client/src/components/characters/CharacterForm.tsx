import { useFieldArray, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Plus, Trash2 } from "lucide-react";

const characterSchema = z.object({
  name: z.string().min(1, "角色名不能为空"),
  gender: z.string().optional(),
  age: z.coerce.number().optional(),
  appearance: z.string().optional(),
  personality: z.string().optional(),
  catchphrase: z.string().optional(),
  speech_style: z.string().optional(),
  identity: z.string().optional(),
  backstory: z.string().optional(),
  motivation: z.string().optional(),
  custom_fields: z.array(z.object({ key: z.string(), value: z.string() })).optional(),
});

export type CharacterFormData = z.infer<typeof characterSchema>;

interface Props {
  defaultValues?: Partial<CharacterFormData>;
  onSubmit: (data: CharacterFormData) => void;
  onCancel: () => void;
  isPending?: boolean;
}

const FIXED_FIELDS = [
  { name: "name" as const, label: "角色名", required: true, component: "input" },
  { name: "gender" as const, label: "性别", component: "input" },
  { name: "age" as const, label: "年龄", component: "input", type: "number" },
  { name: "identity" as const, label: "身份/职业", component: "input" },
  { name: "catchphrase" as const, label: "口头禅", component: "input" },
  { name: "speech_style" as const, label: "说话风格", component: "input" },
  { name: "appearance" as const, label: "外貌描写", component: "textarea" },
  { name: "personality" as const, label: "性格描述", component: "textarea" },
  { name: "backstory" as const, label: "背景故事", component: "textarea" },
  { name: "motivation" as const, label: "动机/目标", component: "textarea" },
];

export function CharacterForm({ defaultValues, onSubmit, onCancel, isPending }: Props) {
  const form = useForm<CharacterFormData>({
    resolver: zodResolver(characterSchema),
    defaultValues: {
      name: "",
      gender: "",
      age: undefined,
      appearance: "",
      personality: "",
      catchphrase: "",
      speech_style: "",
      identity: "",
      backstory: "",
      motivation: "",
      custom_fields: [],
      ...defaultValues,
    },
  });

  const customFields = useFieldArray({
    control: form.control,
    name: "custom_fields",
  });

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
      {/* 固定字段 */}
      <div className="grid gap-4 sm:grid-cols-2">
        {FIXED_FIELDS.map((field) => (
          <div key={field.name} className={field.component === "textarea" ? "sm:col-span-2" : ""}>
            <Label htmlFor={field.name}>
              {field.label}
              {field.required && <span className="text-destructive ml-0.5">*</span>}
            </Label>
            {field.component === "textarea" ? (
              <Textarea
                id={field.name}
                rows={3}
                {...form.register(field.name)}
              />
            ) : (
              <Input
                id={field.name}
                type={field.type ?? "text"}
                {...form.register(field.name)}
              />
            )}
            {form.formState.errors[field.name] && (
              <p className="text-xs text-destructive mt-1">
                {form.formState.errors[field.name]?.message as string}
              </p>
            )}
          </div>
        ))}
      </div>

      {/* 自定义字段 */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label>自定义字段</Label>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => customFields.append({ key: "", value: "" })}
          >
            <Plus className="size-3" />
          </Button>
        </div>
        {customFields.fields.map((cf, i) => (
          <div key={cf.id} className="flex gap-2">
            <Input
              placeholder="字段名"
              {...form.register(`custom_fields.${i}.key`)}
            />
            <Input
              placeholder="字段值"
              {...form.register(`custom_fields.${i}.value`)}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={() => customFields.remove(i)}
            >
              <Trash2 className="size-3 text-muted-foreground" />
            </Button>
          </div>
        ))}
      </div>

      {/* 操作按钮 */}
      <div className="flex justify-end gap-2 pt-4 border-t border-border">
        <Button type="button" variant="outline" onClick={onCancel}>
          取消
        </Button>
        <Button type="submit" disabled={isPending}>
          {isPending ? "保存中..." : "保存"}
        </Button>
      </div>
    </form>
  );
}
