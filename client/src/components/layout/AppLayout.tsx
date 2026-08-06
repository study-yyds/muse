import { Outlet, useNavigate, useLocation } from "react-router-dom";
import { useAuthStore } from "@/stores/auth";
import { useEffect, useState } from "react";
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

export function AppLayout() {
  const { isAuthenticated, user, logout, fetchProfile } = useAuthStore();
  const navigate = useNavigate();
  const location = useLocation();
  const [settingsOpen, setSettingsOpen] = useState(false);

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

        {/* 全局设置弹窗 */}
        <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>用户设置</DialogTitle>
            </DialogHeader>
            <ApiKeyManager />
          </DialogContent>
        </Dialog>
      </header>

      {/* 内容区 */}
      <main className="flex-1" key={location.pathname}>
        <Outlet />
      </main>
    </div>
  );
}
