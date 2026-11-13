import { useState, type FormEvent } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import type { MemberInput } from "../../../shared/schemas";
import { api } from "../../lib/api";
import { useAction, useResource } from "../../lib/useResource";
import { ICON_PROPS } from "../../components/Layout";
import { Button, Checkbox, ErrorText, Field, Hint, Section, TextInput, LoadError } from "../../components/ui";

type Member = MemberInput & { id: string };

const EMPTY: MemberInput = { name: "", aliases: [], isMe: false };

const splitAliases = (s: string) =>
  s
    .split(/[,、，\n]/)
    .map((a) => a.trim())
    .filter(Boolean);

function MemberForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: MemberInput;
  submitLabel: string;
  onSubmit: (v: MemberInput) => Promise<boolean>;
  onCancel?: () => void;
}) {
  const [name, setName] = useState(initial.name);
  const [aliases, setAliases] = useState(initial.aliases.join("、"));
  const [isMe, setIsMe] = useState(initial.isMe);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const ok = await onSubmit({ name, aliases: splitAliases(aliases), isMe });
    setBusy(false);
    if (ok && !onCancel) {
      setName("");
      setAliases("");
      setIsMe(false);
    }
  };

  return (
    <form onSubmit={submit} className="grid gap-2 py-2">
      <div className="grid grid-cols-2 gap-2">
        <Field label="名前" id="memberName">
          <TextInput id="memberName" maxLength={40} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="別名（、区切り）" id="aliases">
          <TextInput id="aliases" value={aliases} onChange={(e) => setAliases(e.target.value)} />
        </Field>
      </div>
      <Checkbox label="自分" checked={isMe} onChange={(e) => setIsMe(e.target.checked)} />
      <div className="flex items-center gap-2">
        <Button type="submit" variant={onCancel ? "primary" : "secondary"} disabled={busy || !name.trim()}>
          {!onCancel && <Plus {...ICON_PROPS} />}
          {submitLabel}
        </Button>
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel}>
            キャンセル
          </Button>
        )}
      </div>
    </form>
  );
}

export function MemberSettings() {
  const { data, error: loadError, reload } = useResource<{ members: Member[] }>("/members");
  const [editing, setEditing] = useState<string | null>(null);
  const { error, run } = useAction();
  const hasMe = data?.members.some((m) => m.isMe);

  const save = (id: string | null) => (v: MemberInput) =>
    run(async () => {
      await api(id ? `/members/${id}` : "/members", { method: id ? "PUT" : "POST", body: v });
      setEditing(null);
      reload();
    });

  const remove = (m: Member) => {
    if (!confirm(`${m.name} さんを削除しますか？ シフトも削除されます`)) return;
    run(async () => {
      await api(`/members/${m.id}`, { method: "DELETE" });
      reload();
    });
  };

  return (
    <Section title="メンバー">
      <ul className="max-w-md border-t border-ink-100">
        {data?.members.map((m) =>
          editing === m.id ? (
            <li key={m.id} className="border-b border-ink-100">
              <MemberForm initial={m} submitLabel="保存" onSubmit={save(m.id)} onCancel={() => setEditing(null)} />
            </li>
          ) : (
            <li key={m.id} className="flex items-center gap-2 border-b border-ink-100 py-1">
              <div className="min-w-0 flex-1">
                <p className="text-base">
                  {m.name}
                  {m.isMe && <span className="pl-1 text-xs text-ink-500">自分</span>}
                </p>
                {m.aliases.length > 0 && <p className="truncate text-xs text-ink-500">{m.aliases.join("、")}</p>}
              </div>
              <Button variant="ghost" aria-label="編集" onClick={() => setEditing(m.id)}>
                <Pencil {...ICON_PROPS} />
              </Button>
              <Button variant="ghost" aria-label="削除" onClick={() => remove(m)}>
                <Trash2 {...ICON_PROPS} />
              </Button>
            </li>
          ),
        )}
      </ul>
      {data && !hasMe && <Hint>「自分」に設定したメンバーのシフトで給与を計算します</Hint>}
      {loadError && <LoadError message={loadError} onRetry={reload} />}
      {/* 読み込めていない間は追加フォームを出さない (空の一覧と区別するため) */}
      {editing === null && data && (
        <div className="max-w-md">
          <MemberForm initial={EMPTY} submitLabel="メンバーを追加" onSubmit={save(null)} />
        </div>
      )}
      <ErrorText>{error}</ErrorText>
    </Section>
  );
}
