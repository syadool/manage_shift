import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { startAuthentication, startRegistration, WebAuthnError } from "@simplewebauthn/browser";
import { api, ApiError } from "./api";

export type User = { id: string; displayName: string };

type AuthState = {
  user: User | null | undefined; // undefined = 確認中
  /** 通信できずにログイン状態を確認できなかった (未ログインとは区別する) */
  unreachable: boolean;
  recheck: () => void;
  login: () => Promise<void>;
  register: (displayName: string) => Promise<void>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

/** この端末のパスキーにつける既定の名前 */
export function guessDeviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Macintosh/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows";
  return "パスキー";
}

/** WebAuthn / API のエラーを利用者向けの文言に */
export function authErrorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof WebAuthnError || (e instanceof Error && e.name === "NotAllowedError")) {
    return "パスキーの操作がキャンセルされました";
  }
  return "パスキーを利用できませんでした";
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null | undefined>(undefined);

  const [unreachable, setUnreachable] = useState(false);

  const recheck = useCallback(() => {
    setUnreachable(false);
    api<{ user: User }>("/auth/me")
      .then((r) => setUser(r.user))
      .catch((e) => {
        // 401 は未ログイン。それ以外 (オフラインやサーバーエラー) はログイン画面にせず、通信できないことを伝える
        if (e instanceof ApiError && e.status === 401) setUser(null);
        else setUnreachable(true);
      });
  }, []);
  useEffect(recheck, [recheck]);

  const login = useCallback(async () => {
    const optionsJSON = await api<Parameters<typeof startAuthentication>[0]["optionsJSON"]>(
      "/auth/login/options",
      { body: {} },
    );
    const response = await startAuthentication({ optionsJSON });
    const r = await api<{ user: User }>("/auth/login/verify", { body: { response } });
    setUser(r.user);
  }, []);

  const register = useCallback(async (displayName: string) => {
    const optionsJSON = await api<Parameters<typeof startRegistration>[0]["optionsJSON"]>(
      "/auth/register/options",
      { body: { displayName } },
    );
    const response = await startRegistration({ optionsJSON });
    const r = await api<{ user: User }>("/auth/register/verify", {
      body: { response, name: guessDeviceName() },
    });
    setUser(r.user);
  }, []);

  const logout = useCallback(async () => {
    await api("/auth/logout", { body: {} });
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, unreachable, recheck, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("AuthProvider missing");
  return ctx;
}
