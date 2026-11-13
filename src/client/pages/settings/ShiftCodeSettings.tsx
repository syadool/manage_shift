import { useState, type FormEvent } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import type { ShiftCodeInput } from "../../../shared/schemas";
import { api } from "../../lib/api";
import { useAction, useResource } from "../../lib/useResource";
import { ICON_PROPS } from "../../components/Layout";
import { Button, Checkbox, ErrorText, Field, Section, TextInput } from "../../components/ui";

type ShiftCode = ShiftCodeInput & { id: string };

const EMPTY: ShiftCodeInput = { symbol: "", isOff: false, startTime: "", endTime: "", breakMinutes: 0 };

export function describeCode(c: ShiftCodeInput) {
  if (c.isOff) return "休み";
  const brk = c.breakMinutes ? ` 休憩${c.breakMinutes}分` : "";
  return `${c.startTime}〜${c.endTime}${brk}`;
}

function CodeForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: ShiftCodeInput;
  submitLabel: string;
  onSubmit: (v: ShiftCodeInput) => Promise<boolean>;
  onCancel?: () => void;
}) {
  const [v, setV] = useState(initial);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<ShiftCodeInput>) => setV({ ...v, ...patch });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const ok = await onSubmit({
      ...v,
      startTime: v.isOff ? null : v.startTime || null,
      endTime: v.isOff ? null : v.endTime || null,
    });
    setBusy(false);
    if (ok && !onCancel) setV(EMPTY);
  };

  return (
    <form onSubmit={submit} className="grid gap-2 py-2">
      <div className="grid grid-cols-[80px_1fr] items-end gap-2">
        <Field label="記号" id="symbol">
          <TextInput id="symbol" maxLength={8} value={v.symbol} onChange={(e) => set({ symbol: e.target.value })} />
        </Field>
        <div className="pb-1">
          <Checkbox label="休み" checked={v.isOff} onChange={(e) => set({ isOff: e.target.checked })} />
        </div>
      </div>
      {!v.isOff && (
        <div className="grid grid-cols-3 gap-2">
          <Field label="開始" id="startTime">
            <TextInput
              id="startTime"
              type="time"
              value={v.startTime ?? ""}
              onChange={(e) => set({ startTime: e.target.value })}
            />
          </Field>
          <Field label="終了" id="endTime">
            <TextInput
              id="endTime"
              type="time"
              value={v.endTime ?? ""}
              onChange={(e) => set({ endTime: e.target.value })}
            />
          </Field>
          <Field label="休憩（分）" id="breakMinutes">
            <TextInput
              id="breakMinutes"
              inputMode="numeric"
              value={v.breakMinutes ? String(v.breakMinutes) : ""}
              onChange={(e) => set({ breakMinutes: Number(e.target.value) || 0 })}
            />
          </Field>
        </div>
      )}
      <div className="flex items-center gap-2">
        <Button type="submit" variant={onCancel ? "primary" : "secondary"} disabled={busy || !v.symbol.trim()}>
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

export function ShiftCodeSettings() {
  const { data, reload } = useResource<{ shiftCodes: ShiftCode[] }>("/shift-codes");
  const [editing, setEditing] = useState<string | null>(null);
  const { error, run } = useAction();

  const save = (id: string | null) => (v: ShiftCodeInput) =>
    run(async () => {
      await api(id ? `/shift-codes/${id}` : "/shift-codes", { method: id ? "PUT" : "POST", body: v });
      setEditing(null);
      reload();
    });

  const remove = (c: ShiftCode) => {
    if (!confirm(`記号「${c.symbol}」を削除しますか？`)) return;
    run(async () => {
      await api(`/shift-codes/${c.id}`, { method: "DELETE" });
      reload();
    });
  };

  return (
    <Section title="記号">
      <ul className="max-w-md border-t border-ink-100">
        {data?.shiftCodes.map((c) =>
          editing === c.id ? (
            <li key={c.id} className="border-b border-ink-100">
              <CodeForm initial={c} submitLabel="保存" onSubmit={save(c.id)} onCancel={() => setEditing(null)} />
            </li>
          ) : (
            <li key={c.id} className="flex items-center gap-2 border-b border-ink-100 py-1">
              <span className="w-5 shrink-0 text-base">{c.symbol}</span>
              <span className={`flex-1 text-sm ${c.isOff ? "text-ink-500" : ""}`}>{describeCode(c)}</span>
              <Button variant="ghost" aria-label="編集" onClick={() => setEditing(c.id)}>
                <Pencil {...ICON_PROPS} />
              </Button>
              <Button variant="ghost" aria-label="削除" onClick={() => remove(c)}>
                <Trash2 {...ICON_PROPS} />
              </Button>
            </li>
          ),
        )}
      </ul>
      {editing === null && (
        <div className="max-w-md">
          <CodeForm initial={EMPTY} submitLabel="記号を追加" onSubmit={save(null)} />
        </div>
      )}
      <ErrorText>{error}</ErrorText>
    </Section>
  );
}
