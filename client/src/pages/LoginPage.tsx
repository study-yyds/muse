import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useAuthStore } from "@/stores/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { BookOpen, Loader2 } from "lucide-react";
import { api } from "@/services/api";

const loginSchema = z.object({
  phone: z.string().min(11, "请输入有效手机号").max(11),
  code: z.string().min(4, "验证码至少 4 位"),
});

type LoginFormData = z.infer<typeof loginSchema>;

export function LoginPage() {
  const [isSending, setIsSending] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const login = useAuthStore((s) => s.login);
  const navigate = useNavigate();

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
    setError,
  } = useForm<LoginFormData>({
    resolver: zodResolver(loginSchema),
    defaultValues: { phone: "", code: "" },
  });

  const sendCode = async () => {
    const phone = (document.getElementById("phone") as HTMLInputElement)?.value;
    if (!phone || phone.length !== 11) return;

    setIsSending(true);
    try {
      const res = await api.post<{ data: { code: string } }>("/auth/send-code", { phone_number: phone });
      // V1 阶段验证码直接在页面展示，V2 接入短信后移除
      alert(`验证码：${res.data.code}`);
      setCountdown(60);
      const timer = setInterval(() => {
        setCountdown((prev) => {
          if (prev <= 1) { clearInterval(timer); return 0; }
          return prev - 1;
        });
      }, 1000);
    } catch {
      setError("phone", { message: "发送失败" });
    } finally {
      setIsSending(false);
    }
  };

  const onSubmit = async (data: LoginFormData) => {
    try {
      await login(data.phone, data.code);
      navigate("/", { replace: true });
    } catch {
      setError("code", { message: "验证码错误" });
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <BookOpen className="mx-auto size-8 text-primary" />
          <CardTitle className="mt-2">登录 Muse</CardTitle>
          <CardDescription>AI 写作助手</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="phone">手机号</Label>
              <Input id="phone" placeholder="输入手机号" maxLength={11} {...register("phone")} />
              {errors.phone && (
                <p className="text-xs text-destructive">{errors.phone.message}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="code">验证码</Label>
              <div className="flex gap-2">
                <Input id="code" placeholder="输入验证码" {...register("code")} className="flex-1" />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={isSending || countdown > 0}
                  onClick={sendCode}
                  className="shrink-0"
                >
                  {countdown > 0 ? `${countdown}s` : "获取验证码"}
                </Button>
              </div>
              {errors.code && (
                <p className="text-xs text-destructive">{errors.code.message}</p>
              )}
            </div>

            <Button type="submit" className="w-full" disabled={isSubmitting}>
              {isSubmitting && <Loader2 className="size-4 animate-spin" />}
              登录
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
