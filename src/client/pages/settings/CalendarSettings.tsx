import { useEffect, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router";
import { CalendarSync, RefreshCw, Unlink } from "lucide-react";
import type { GcalSettingsInput } from "../../../shared/schemas";
import { api } from "../../lib/api";
import { useAction, useResource } from "../../lib/useResource";
import { ICON_PROPS } from "../../components/Layout";
import { Button, ErrorText, Field, Hint, LoadError, Section, TextInput } from "../../components/ui";

type Connection = GcalSettingsInput & {
  status: "active" | "reauth_required";
  pending: boolean;
  hasCalendar: boolean;
  lastSyncedAt: string | null;
  lastError: string | null;
};
type Status = { available: boolean; connection: Connection | null };

const RESULT_MESSAGES: Record<string, string> = {
  connected: "Google カレンダーと連携しました。予定の反映には少し時間がかかることがあります",
  denied: "連携をキャンセルしました",
  error: "連携に失敗しました。もう一度お試しください",
};

const fmt = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";

function TitleSettings({ connection, onSaved }: { connection: Connection; onSaved: () => void }) {
  const [titleMode, setTitleMode] = useState(connection.titleMode);
  const [workplaceName, setWorkplaceName] = useState(connection.workplaceName ?? "");
  const [saved, setSaved] = useState(false);
  const { busy, error, run } = useAction();

  useEffect(() => {
    setTitleMode(connection.titleMode);
    setWorkplaceName(connection.workplaceName ?? "");
  }, [connection.titleMode, connection.workplaceName]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const body: GcalSettingsInput = { titleMode, workplaceName: workplaceName.trim() || null };
    if (await run(() => api("/gcal/settings", { method: "PUT", body }))) {
      setSaved(true);
      onSaved();
    }
  };

  const radio = (value: GcalSettingsInput["titleMode"], label: string) => (
    <label className="inline-flex items-center gap-1 text-sm">
      <input
        type="radio"
        name="titleMode"
        className="size-2 accent-ink-900"
        checked={titleMode === value}
        onChange={() => {
          setTitleMode(value);
          setSaved(false);
        }}
      />
      {label}
    </label>
  );

  return (
    <form onSubmit={onSubmit} className="grid gap-2 pt-2">
      <fieldset>
        <legend className="pb-1 text-xs text-ink-500">予定のタイトル</legend>
        <div className="flex gap-3">
          {radio("symbol", "シフトの記号")}
          {radio("workplace", "バイト先名")}
        </div>
      </fieldset>
      {titleMode === "workplace" && (
        <Field label="バイト先名" id="workplaceName">
          <TextInput
            id="workplaceName"
            maxLength={40}
            placeholder="例: 駅前店"
            value={workplaceName}
            onChange={(e) => {
              setWorkplaceName(e.target.value);
              setSaved(false);
            }}
          />
        </Field>
      )}
      <div className="flex items-center gap-2">
        <Button type="submit" variant="secondary" disabled={busy}>
          保存
        </Button>
        {saved && <span className="text-sm text-ink-500">保存しました</span>}
      </div>
      <ErrorText>{error}</ErrorText>
    </form>
  );
}

export function CalendarSettings() {
  const { data, error: loadError, reload } = useResource<Status>("/gcal");
  const [params, setParams] = useSearchParams();
  const [notice, setNotice] = useState("");
  const { busy, error, run } = useAction();

  // Google から戻ってきたときの結果を表示し、URL からは消す
  useEffect(() => {
    const result = params.get("gcal");
    if (!result) return;
    setNotice(RESULT_MESSAGES[result] ?? "");
    const next = new URLSearchParams(params);
    next.delete("gcal");
    setParams(next, { replace: true });
  }, [params, setParams]);

  if (!data) {
    return loadError ? (
      <Section title="Google カレンダー">
        <LoadError message={loadError} onRetry={reload} />
      </Section>
    ) : null;
  }
  if (!data.available) return null;

  const connect = () =>
    run(async () => {
      const { url } = await api<{ url: string }>("/gcal/connect", { body: {} });
      window.location.href = url;
    });
  const syncNow = () =>
    run(async () => {
      await api("/gcal/sync", { body: {} });
      setNotice("反映しました");
      reload();
    });
  const disconnect = () => {
    if (!confirm("連携を解除しますか？ Google カレンダーの「シフト (manageshift)」カレンダーも削除されます")) return;
    run(async () => {
      await api("/gcal", { method: "DELETE" });
      setNotice("");
      reload();
    });
  };

  const c = data.connection;
  return (
    <Section title="Google カレンダー">
      <div className="max-w-md">
        {!c ? (
          <>
            <p className="pb-2 text-sm">
              自分のシフトを Google カレンダーに自動で反映します。専用の「シフト (manageshift)」カレンダーを作り、そこにだけ書き込みます。
            </p>
            <Button onClick={connect} disabled={busy}>
              <CalendarSync {...ICON_PROPS} />
              Google カレンダーと連携
            </Button>
          </>
        ) : c.status === "reauth_required" ? (
          <>
            <p className="pb-2 text-sm">Google との連携が切れています。もう一度連携してください。</p>
            <div className="flex gap-2">
              <Button onClick={connect} disabled={busy}>
                <CalendarSync {...ICON_PROPS} />
                もう一度連携
              </Button>
              <Button variant="ghost" onClick={disconnect} disabled={busy}>
                <Unlink {...ICON_PROPS} />
                連携を解除
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="text-sm">連携中: 自分のシフトを「シフト (manageshift)」カレンダーに反映しています</p>
            <p className="text-xs text-ink-500">
              最終反映 {fmt(c.lastSyncedAt)}
              {c.pending ? " ・ 反映待ちの変更があります" : ""}
            </p>
            {c.lastError && <p className="pt-1 text-sm text-ink-900">{c.lastError}</p>}
            <div className="flex gap-2 pt-2">
              <Button variant="secondary" onClick={syncNow} disabled={busy}>
                <RefreshCw {...ICON_PROPS} />
                今すぐ反映
              </Button>
              <Button variant="ghost" onClick={disconnect} disabled={busy}>
                <Unlink {...ICON_PROPS} />
                連携を解除
              </Button>
            </div>
            <TitleSettings connection={c} onSaved={reload} />
            <Hint>時間は予定の開始・終了に入るため、タイトルには入れません</Hint>
          </>
        )}
        {notice && <p className="pt-1 text-sm text-ink-500">{notice}</p>}
        <ErrorText>{error}</ErrorText>
      </div>
    </Section>
  );
}
