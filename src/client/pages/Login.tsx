import { useState, type FormEvent } from "react";
import { KeyRound } from "lucide-react";
import { authErrorMessage, useAuth } from "../lib/auth";
import { Button, ErrorText, Label, TextInput } from "../components/ui";
import { ICON_PROPS } from "../components/Layout";

/** ログインはパスキーのみ。説明文やキャッチコピーは置かない */
export function Login() {
  const { login, register } = useAuth();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(authErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const onRegister = (e: FormEvent) => {
    e.preventDefault();
    run(() => register(name.trim()));
  };

  return (
    <div className="mx-auto max-w-sm px-3 pt-10">
      {mode === "login" ? (
        <div className="flex flex-col items-start gap-3">
          <Button onClick={() => run(login)} disabled={busy}>
            <KeyRound {...ICON_PROPS} />
            パスキーでログイン
          </Button>
          <Button variant="ghost" onClick={() => setMode("register")} disabled={busy}>
            新規登録
          </Button>
        </div>
      ) : (
        <form onSubmit={onRegister} className="flex flex-col items-start gap-3">
          <div className="w-full">
            <Label htmlFor="displayName">名前</Label>
            <TextInput
              id="displayName"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={40}
              autoComplete="username webauthn"
              required
            />
          </div>
          <Button type="submit" disabled={busy || !name.trim()}>
            <KeyRound {...ICON_PROPS} />
            パスキーを作成
          </Button>
          <Button type="button" variant="ghost" onClick={() => setMode("login")} disabled={busy}>
            ログインに戻る
          </Button>
        </form>
      )}
      <ErrorText>{error}</ErrorText>
    </div>
  );
}
