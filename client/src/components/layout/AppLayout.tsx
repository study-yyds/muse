import { Outlet, useNavigate, useLocation } from "react-router-dom";
import { useAuthStore } from "@/stores/auth";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/services/api";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { BookOpen, LogOut, User, Shield, Settings } from "lucide-react";
import { ApiKeyManager } from "@/components/settings/ApiKeyManager";
import { ModelSelector, customKeyValue } from "@/components/settings/ModelSelector";
import { PlansDialog } from "@/components/settings/PlansDialog";
import { planNameFor } from "@/lib/plans";
import { getDefaultModel, setDefaultModel } from "@/lib/default-model";

export function AppLayout() {
  const { isAuthenticated, user, logout, fetchProfile } = useAuthStore();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [plansOpen, setPlansOpen] = useState(false);
  // 默认生成模型（用户级：无单独选择器的 AI 功能统一使用）
  const [defaultModel, setDefaultModelState] = useState(getDefaultModel().model);
  const [defaultKeyId, setDefaultKeyId] = useState(getDefaultModel().keyId ?? "");

  // 本月 AI 用量（账号级：与具体作品无关，放全局用户设置）
  const { data: quotaData } = useQuery({
    queryKey: ["ai-quota"],
    queryFn: () =>
      api.get<{
        data: {
          used_words: number;
          quota_words: number | null;
          remaining: number | null;
          month: string;
        };
      }>(`/ai/quota`),
    enabled: isAuthenticated,
  });
  const quota = quotaData?.data;

  useEffect(() => {
    if (!isAuthenticated) {
      navigate("/login", { replace: true });
    } else if (!user) {
      fetchProfile();
    }
  }, [isAuthenticated, user, navigate, fetchProfile]);

  if (!isAuthenticated) return null;

  return (
    <div className="flex min-h-screen flex-col">
      {/* 顶部导航 */}
      <header className="flex h-12 items-center justify-between border-b border-border px-4 shrink-0">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate("/")}
            className="flex items-center gap-2 font-medium text-foreground hover:text-primary transition-colors"
          >
            <BookOpen className="size-5" />
            <span className="text-sm">Muse</span>
          </button>
          {user?.role === "admin" && (
            <button
              onClick={() => navigate("/admin")}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors"
            >
              <Shield className="size-3.5" />
              管理
            </button>
          )}
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="ghost" size="icon-sm" className="rounded-full">
                <Avatar className="size-7">
                  <AvatarFallback className="text-xs">
                    {user?.phone_number?.slice(0, 2) ?? <User className="size-3" />}
                  </AvatarFallback>
                </Avatar>
              </Button>
            }
          />
          <DropdownMenuContent align="end" className="w-40">
            <DropdownMenuItem onClick={() => setSettingsOpen(true)}>
              <Settings className="size-4" />
              设置
            </DropdownMenuItem>
            <DropdownMenuItem onClick={logout}>
              <LogOut className="size-4" />
              退出登录
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* 全局用户设置弹窗：账号级内容（用量/套餐/API Key） */}
        <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>用户设置</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              {quota && quota.quota_words != null && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">本月 AI 用量</span>
                    <span className="text-xs text-muted-foreground">
                      {planNameFor(quota.quota_words)}
                    </span>
                    <Button
                      size="xs"
                      variant="outline"
                      className="ml-auto"
                      onClick={() => setPlansOpen(true)}
                    >
                      升级套餐
                    </Button>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
                      <div
                        className="h-full bg-primary transition-all"
                        style={{
                          width: `${Math.min(100, (quota.used_words / quota.quota_words) * 100)}%`,
                        }}
                      />
                    </div>
                    <span className="text-xs text-muted-foreground shrink-0">
                      {quota.used_words.toLocaleString()} /{" "}
                      {quota.quota_words.toLocaleString()} 字
                    </span>
                  </div>
                </div>
              )}
              <ApiKeyManager />

              <div className="space-y-2 border-t border-border pt-3">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">默认生成模型</span>
                </div>
                <ModelSelector
                  usage="chat"
                  allowAuto
                  value={defaultKeyId ? customKeyValue(defaultKeyId) : defaultModel}
                  onChange={(m, keyId) => {
                    setDefaultModel(m, keyId);
                    setDefaultModelState(m);
                    setDefaultKeyId(keyId ?? "");
                  }}
                  className="w-full rounded border border-border bg-background px-2 py-1 text-sm"
                />
                <p className="text-xs text-muted-foreground">
                  没有单独模型选择的 AI 功能（整章生成、章纲生成等）统一使用此设置；
                  留空为智能默认（后端按场景自动选）。
                </p>
              </div>
            </div>
          </DialogContent>
        </Dialog>

        {/* 套餐升级弹窗（独立于设置弹窗渲染，避免嵌套 Dialog 焦点问题） */}
        <PlansDialog
          open={plansOpen}
          onOpenChange={setPlansOpen}
          currentQuotaWords={quota?.quota_words ?? null}
          onPurchased={() =>
            queryClient.invalidateQueries({ queryKey: ["ai-quota"] })
          }
        />
      </header>

      {/* 内容区 */}
      <main className="flex-1" key={location.pathname}>
        <Outlet />
      </main>
    </div>
  );
}
