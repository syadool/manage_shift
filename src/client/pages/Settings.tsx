import { useCallback, useEffect, useState } from "react";
import { startRegistration } from "@simplewebauthn/browser";
import { LogOut, Plus, Trash2 } from "lucide-react";
import { api } from "../lib/api";
import { authErrorMessage, guessDeviceName, useAuth } from "../lib/auth";
import { Button, ErrorText, SectionHeading } from "../components/ui";
import { ICON_PROPS } from "../components/Layout";

type Passkey = { id: string; name: string; createdAt: string; lastUsedAt: string | null; backedUp: boolean };

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("ja-JP") : "—");

export function Settings() {
  const { user, logout } = useAuth();
  const [keys, setKeys] = useState<Passkey[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<{ passkeys: Passkey[] }>("/auth/passkeys").then((r) => setKeys(r.passkeys));
  }, []);
  useEffect(load, [load]);

  const add = async () => {
    setBusy(true);
    setError("");
    try {
      const optionsJSON = await api<Parameters<typeof startRegistration>[0]["optionsJSON"]>(
        "/auth/passkeys/options",
        { body: {} },
      );
      const response = await startRegistration({ optionsJSON });
      await api("/auth/passkeys/verify", { body: { response, name: guessDeviceName() } });
      load();
    } catch (e) {
      setError(authErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    if (!confirm("このパスキーを削除しますか？")) return;
    setError("");
    try {
      await api(`/auth/passkeys/${encodeURIComponent(id)}`, { method: "DELETE" });
      load();
    } catch (e) {
      setError(authErrorMessage(e));
    }
  };

  return (
    <div className="max-w-xl">
      <section className="pb-5">
        <SectionHeading>アカウント</SectionHeading>
        <p className="pb-2 text-base">{user?.displayName}</p>
        <Button variant="ghost" onClick={logout}>
          <LogOut {...ICON_PROPS} />
          ログアウト
        </Button>
      </section>

      <section>
        <SectionHeading>パスキー</SectionHeading>
        <ul className="border-t border-ink-100">
          {keys.map((k) => (
            <li key={k.id} className="flex items-center justify-between border-b border-ink-100 py-2">
              <div>
                <p className="text-base">{k.name}</p>
                <p className="text-xs text-ink-500">
                  登録 {fmt(k.createdAt)} ・ 最終使用 {fmt(k.lastUsedAt)}
                  {k.backedUp ? " ・ 同期済み" : ""}
                </p>
              </div>
              <Button
                variant="ghost"
                aria-label="削除"
                onClick={() => remove(k.id)}
                disabled={keys.length <= 1}
              >
                <Trash2 {...ICON_PROPS} />
              </Button>
            </li>
          ))}
        </ul>
        <div className="pt-2">
          <Button variant="secondary" onClick={add} disabled={busy}>
            <Plus {...ICON_PROPS} />
            この端末のパスキーを追加
          </Button>
        </div>
        <ErrorText>{error}</ErrorText>
      </section>
    </div>
  );
}
