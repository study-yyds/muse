import { Outlet, useNavigate, useLocation } from "react-router-dom";
import { useAuthStore } from "@/stores/auth";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { BookOpen, LogOut, User } from "lucide-react";

export function AppLayout() {
  const { isAuthenticated, user, logout, fetchProfile } = useAuthStore();
  const navigate = useNavigate();
  const location = useLocation();

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
        <button
          onClick={() => navigate("/")}
          className="flex items-center gap-2 font-medium text-foreground hover:text-primary transition-colors"
        >
          <BookOpen className="size-5" />
          <span className="text-sm">Muse</span>
        </button>

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
            <DropdownMenuItem onClick={logout}>
              <LogOut className="size-4" />
              退出登录
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      {/* 内容区 */}
      <main className="flex-1" key={location.pathname}>
        <Outlet />
      </main>
    </div>
  );
}
