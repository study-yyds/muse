import { create } from "zustand";
import { persist } from "zustand/middleware";
import { api } from "../services/api";

interface User {
  user_id: string;
  phone_number: string;
  avatar_path: string | null;
}

interface AuthState {
  token: string | null;
  user: User | null;
  isAuthenticated: boolean;
  login: (phone: string, code: string) => Promise<void>;
  logout: () => void;
  fetchProfile: () => Promise<void>;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      token: null,
      user: null,
      isAuthenticated: false,

      login: async (phone: string, code: string) => {
        const res = await api.post<{ data: { access_token: string; user_id: string } }>(
          "/auth/login",
          { phone_number: phone, code }
        );
        const token = res.data.access_token;
        localStorage.setItem("token", token);
        set({ token, isAuthenticated: true });
        await get().fetchProfile();
      },

      logout: () => {
        localStorage.removeItem("token");
        set({ token: null, user: null, isAuthenticated: false });
      },

      fetchProfile: async () => {
        try {
          const res = await api.get<{ data: User }>("/user/profile");
          set({ user: res.data });
        } catch {
          // 后端不可用时保留登录态，不登出
        }
      },
    }),
    {
      name: "muse-auth",
      partialize: (state) => ({ token: state.token, isAuthenticated: state.isAuthenticated }),
    }
  )
);
