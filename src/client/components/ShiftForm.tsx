import { useState, type FormEvent } from "react";
import { Trash2 } from "lucide-react";
import type { ShiftInput } from "../../shared/schemas";
import { api } from "../lib/api";
import type { Member, Shift, ShiftCode } from "../lib/shiftData";
import { useAction } from "../lib/useResource";
import { ICON_PROPS } from "./Layout";
import { Button, ErrorText, Field, Select, TextInput } from "./ui";

/** シフトの手入力・修正フォーム。記号を選ぶと時刻を自動入力する */
export function ShiftForm({
  date,
  members,
  codes,
  shift,
  defaultMemberId,
  onDone,
}: {
  date: string;
  members: Member[];
  codes: ShiftCode[];
  shift?: Shift;
  defaultMemberId?: string;
  onDone: () => void;
}) {
  const workCodes = codes.filter((c) => !c.isOff);
  const [v, setV] = useState<ShiftInput>(
    shift ?? {
      memberId: defaultMemberId ?? members[0]?.id ?? "",
      date,
      shiftCodeId: null,
      startTime: "",
      endTime: "",
      breakMinutes: 0,
    },
  );
  const { busy, error, run } = useAction();
  const set = (patch: Partial<ShiftInput>) => setV({ ...v, ...patch });

  const pickCode = (id: string) => {
    const code = workCodes.find((c) => c.id === id);
    if (!code) return set({ shiftCodeId: null });
    set({
      shiftCodeId: code.id,
      startTime: code.startTime ?? "",
      endTime: code.endTime ?? "",
      breakMinutes: code.breakMinutes,
    });
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await run(() =>
      api(shift ? `/shifts/${shift.id}` : "/shifts", { method: shift ? "PUT" : "POST", body: { ...v, date } }),
    );
    if (ok) onDone();
  };

  const remove = async () => {
    if (!shift || !confirm("このシフトを削除しますか？")) return;
    if (await run(() => api(`/shifts/${shift.id}`, { method: "DELETE" }))) onDone();
  };

  return (
    <form onSubmit={submit} className="grid max-w-md gap-2 border-t border-ink-100 py-2">
      <div className="grid grid-cols-2 gap-2">
        <Field label="メンバー" id="shiftMember">
          <Select id="shiftMember" value={v.memberId} onChange={(e) => set({ memberId: e.target.value })}>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="記号" id="shiftCode">
          <Select id="shiftCode" value={v.shiftCodeId ?? ""} onChange={(e) => pickCode(e.target.value)}>
            <option value="">時間を指定</option>
            {workCodes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.symbol}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <Field label="開始" id="shiftStart">
          <TextInput
            id="shiftStart"
            type="time"
            value={v.startTime}
            onChange={(e) => set({ startTime: e.target.value, shiftCodeId: null })}
          />
        </Field>
        <Field label="終了" id="shiftEnd">
          <TextInput
            id="shiftEnd"
            type="time"
            value={v.endTime}
            onChange={(e) => set({ endTime: e.target.value, shiftCodeId: null })}
          />
        </Field>
        <Field label="休憩（分）" id="shiftBreak">
          <TextInput
            id="shiftBreak"
            inputMode="numeric"
            value={v.breakMinutes ? String(v.breakMinutes) : ""}
            onChange={(e) => set({ breakMinutes: Number(e.target.value) || 0 })}
          />
        </Field>
      </div>
      <div className="flex items-center gap-2">
        <Button type="submit" disabled={busy || !v.memberId || !v.startTime || !v.endTime}>
          保存
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>
          キャンセル
        </Button>
        {shift && (
          <Button type="button" variant="ghost" className="ml-auto" aria-label="削除" onClick={remove}>
            <Trash2 {...ICON_PROPS} />
          </Button>
        )}
      </div>
      <ErrorText>{error}</ErrorText>
    </form>
  );
}
