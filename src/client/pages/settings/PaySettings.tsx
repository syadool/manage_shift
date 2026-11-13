import { useEffect, useState, type FormEvent } from "react";
import type { SettingsInput } from "../../../shared/schemas";
import { api } from "../../lib/api";
import { useAction, useResource } from "../../lib/useResource";
import { Button, Checkbox, ErrorText, Field, Hint, LoadError, Section, Select, TextInput } from "../../components/ui";

/** 年収の壁の候補。制度改正で変わるため、あくまで入力補助 */
const WALL_PRESETS = [
  { yen: 1_060_000, label: "106万 社会保険（勤務先で加入）" },
  { yen: 1_230_000, label: "123万 親の扶養控除" },
  { yen: 1_300_000, label: "130万 社会保険（扶養）" },
  { yen: 1_500_000, label: "150万 特定親族特別控除（19〜22歳）" },
  { yen: 1_600_000, label: "160万 所得税" },
];

/** 保存するときの壁の名前 (候補の表示名から金額部分を除いたもの) */
const presetName = (p: (typeof WALL_PRESETS)[number]) => p.label.replace(/^\S+\s/, "");

/** 金額と名前の両方が一致するときだけ候補とみなす (同額で独自の名前を付けた場合は「金額を入力」のまま) */
const matchPreset = (yen: number | null, label: string | null) =>
  WALL_PRESETS.find((p) => p.yen === yen && presetName(p) === label);

type Form = {
  hourlyWage: string;
  transportPerDay: string;
  wall: string; // "" = なし / "custom" / プリセット金額
  customWall: string;
  wallLabel: string;
  includeTransportInWall: boolean;
};

const toForm = (s: SettingsInput): Form => {
  const preset = matchPreset(s.incomeWallYen, s.wallLabel);
  return {
    hourlyWage: s.hourlyWage ? String(s.hourlyWage) : "",
    transportPerDay: s.transportPerDay ? String(s.transportPerDay) : "",
    wall: s.incomeWallYen == null ? "" : preset ? String(preset.yen) : "custom",
    customWall: s.incomeWallYen != null && !preset ? String(s.incomeWallYen) : "",
    wallLabel: s.wallLabel ?? "",
    includeTransportInWall: s.includeTransportInWall,
  };
};

const num = (v: string) => (v.trim() === "" ? 0 : Number(v.replace(/[,，]/g, "")));

export function PaySettings() {
  const { data, error: loadError, reload } = useResource<{ settings: SettingsInput }>("/settings");
  const [form, setForm] = useState<Form | null>(null);
  const [saved, setSaved] = useState(false);
  const { busy, error, run } = useAction();

  useEffect(() => {
    if (data) setForm(toForm(data.settings));
  }, [data]);

  if (!form) {
    return loadError ? (
      <Section title="給与">
        <LoadError message={loadError} onRetry={reload} />
      </Section>
    ) : null;
  }
  const set = (patch: Partial<Form>) => {
    setForm({ ...form, ...patch });
    setSaved(false);
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const preset = WALL_PRESETS.find((p) => String(p.yen) === form.wall);
    const body: SettingsInput = {
      hourlyWage: num(form.hourlyWage),
      transportPerDay: num(form.transportPerDay),
      incomeWallYen: form.wall === "" ? null : preset ? preset.yen : num(form.customWall),
      wallLabel: form.wall === "" ? null : preset ? presetName(preset) : form.wallLabel || null,
      includeTransportInWall: form.includeTransportInWall,
    };
    if (await run(() => api("/settings", { method: "PUT", body }))) setSaved(true);
  };

  return (
    <Section title="給与">
      <form onSubmit={onSubmit} className="grid max-w-md gap-2">
        <div className="grid grid-cols-2 gap-2">
          <Field label="時給（円）" id="hourlyWage">
            <TextInput
              id="hourlyWage"
              inputMode="numeric"
              value={form.hourlyWage}
              onChange={(e) => set({ hourlyWage: e.target.value })}
            />
          </Field>
          <Field label="交通費（円／日）" id="transportPerDay">
            <TextInput
              id="transportPerDay"
              inputMode="numeric"
              value={form.transportPerDay}
              onChange={(e) => set({ transportPerDay: e.target.value })}
            />
          </Field>
        </div>

        <Field label="年収の壁" id="wall">
          <Select id="wall" value={form.wall} onChange={(e) => set({ wall: e.target.value })}>
            <option value="">設定しない</option>
            {WALL_PRESETS.map((p) => (
              <option key={p.yen} value={p.yen}>
                {p.label}
              </option>
            ))}
            <option value="custom">金額を入力</option>
          </Select>
          <Hint>金額は制度改正で変わります。最新の金額を確認してください</Hint>
        </Field>

        {form.wall === "custom" && (
          <div className="grid grid-cols-2 gap-2">
            <Field label="金額（円）" id="customWall">
              <TextInput
                id="customWall"
                inputMode="numeric"
                value={form.customWall}
                onChange={(e) => set({ customWall: e.target.value })}
              />
            </Field>
            <Field label="名前" id="wallLabel">
              <TextInput
                id="wallLabel"
                maxLength={40}
                value={form.wallLabel}
                onChange={(e) => set({ wallLabel: e.target.value })}
              />
            </Field>
          </div>
        )}

        {form.wall !== "" && (
          <Checkbox
            label="交通費を年収に含める"
            checked={form.includeTransportInWall}
            onChange={(e) => set({ includeTransportInWall: e.target.checked })}
          />
        )}

        <div className="flex items-center gap-2 pt-1">
          <Button type="submit" disabled={busy}>
            保存
          </Button>
          {saved && <span className="text-sm text-ink-500">保存しました</span>}
        </div>
        <ErrorText>{error}</ErrorText>
      </form>
    </Section>
  );
}
