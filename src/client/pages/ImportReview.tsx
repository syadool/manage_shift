import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Check, Plus } from "lucide-react";
import { Link, useNavigate, useParams } from "react-router";
import { monthRange } from "../../shared/dates";
import { matchCode, matchMember, normalizeSymbol, type CommitInput, type Extraction } from "../../shared/importing";
import { normalizeName } from "../../shared/names";
import { api, ApiError } from "../lib/api";
import type { Member, ShiftCode } from "../lib/shiftData";
import { useAction, useResource } from "../lib/useResource";
import { ICON_PROPS } from "../components/Layout";
import { Button, Checkbox, ErrorText, Field, Hint, LoadError, Section, TextInput } from "../components/ui";

type Target = CommitInput["rows"][number]["target"];
type Row = { readName: string; target: Target; cells: Record<number, string> };

/** 読み取り結果から編集用の行を作る。名前が一致するメンバーがいれば紐付け、いなければ新規 */
function initialRows(result: Extraction, members: Member[]): Row[] {
  const used = new Set<string>();
  return result.rows.map((r) => {
    const m = matchMember(r.name, members);
    let target: Target;
    if (m && !used.has(m.id)) {
      used.add(m.id);
      target = { type: "member", memberId: m.id, rememberAlias: true };
    } else {
      target = { type: "new", name: r.name };
    }
    return { readName: r.name, target, cells: Object.fromEntries(r.cells.map((c) => [c.day, c.symbol])) };
  });
}

function daysOf(yearMonth: string, result: Extraction): number[] {
  const last = /^\d{4}-\d{2}$/.test(yearMonth)
    ? Number(monthRange(yearMonth).to.slice(8))
    : Math.max(28, ...result.rows.flatMap((r) => r.cells.map((c) => c.day)));
  return Array.from({ length: last }, (_, i) => i + 1);
}

/** 表の中で使う小さな入力欄 (高さ 32px) */
const COMPACT =
  "block h-4 w-full rounded-sm border border-ink-300 bg-white px-1 text-sm outline-none focus:border-ink-900";

const targetValue = (t: Target) => (t.type === "member" ? `m:${t.memberId}` : t.type);

/** 記号表に無い記号を、その場で記号表に追加する */
function AddCodeInline({ symbol, onAdded }: { symbol: string; onAdded: () => void }) {
  const [isOff, setIsOff] = useState(false);
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [brk, setBrk] = useState("");
  const { busy, error, run } = useAction();
  const id = `code-${symbol}`;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await run(() =>
      api("/shift-codes", {
        body: {
          symbol: normalizeSymbol(symbol),
          isOff,
          startTime: isOff ? null : start || null,
          endTime: isOff ? null : end || null,
          breakMinutes: isOff ? 0 : Number(brk) || 0,
        },
      }),
    );
    if (ok) onAdded();
  };

  return (
    <form onSubmit={submit} className="grid gap-1 border-b border-ink-100 py-2">
      <div className="flex flex-wrap items-end gap-2">
        <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-sm bg-ink-900 px-1 text-sm text-white">
          {symbol}
        </span>
        <div className="pb-1">
          <Checkbox label="休み" checked={isOff} onChange={(e) => setIsOff(e.target.checked)} />
        </div>
        {!isOff && (
          <>
            <div className="w-15">
              <Field label="開始" id={`${id}-s`}>
              <TextInput id={`${id}-s`} type="time" value={start} onChange={(e) => setStart(e.target.value)} />
            </Field>
            </div>
            <div className="w-15">
              <Field label="終了" id={`${id}-e`}>
              <TextInput id={`${id}-e`} type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
            </Field>
            </div>
            <div className="w-10">
              <Field label="休憩（分）" id={`${id}-b`}>
              <TextInput id={`${id}-b`} inputMode="numeric" value={brk} onChange={(e) => setBrk(e.target.value)} />
            </Field>
            </div>
          </>
        )}
        <Button type="submit" variant="secondary" inline disabled={busy || (!isOff && (!start || !end))}>
          <Plus {...ICON_PROPS} />
          記号表に追加
        </Button>
      </div>
      <ErrorText>{error}</ErrorText>
    </form>
  );
}

export function ImportReview() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const imp = useResource<{ import: { status: string; targetMonth: string | null }; result: Extraction | null }>(
    `/imports/${id}`,
  );
  const membersRes = useResource<{ members: Member[] }>("/members");
  const codesRes = useResource<{ shiftCodes: ShiftCode[] }>("/shift-codes");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [yearMonth, setYearMonth] = useState("");
  const { busy, error, run, setError } = useAction();

  const result = imp.data?.result ?? null;
  const members = membersRes.data?.members;
  const codes = codesRes.data?.shiftCodes ?? [];

  useEffect(() => {
    if (result && members && rows === null) {
      setRows(initialRows(result, members));
      setYearMonth(result.yearMonth ?? "");
    }
  }, [result, members, rows]);

  const days = useMemo(() => (result ? daysOf(yearMonth, result) : []), [yearMonth, result]);

  const unknownSymbols = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows ?? []) {
      if (r.target.type === "skip") continue;
      for (const s of Object.values(r.cells)) if (normalizeSymbol(s) && !matchCode(s, codes)) set.add(normalizeSymbol(s));
    }
    return [...set];
  }, [rows, codes]);

  const loadError = imp.error || membersRes.error || codesRes.error;
  if (loadError) {
    return (
      <LoadError
        message={loadError}
        onRetry={() => {
          imp.reload();
          membersRes.reload();
          codesRes.reload();
        }}
      />
    );
  }
  if (!imp.data || !members || !codesRes.data || !rows) return null;
  if (imp.data.import.status !== "parsed" || !result) {
    return (
      <p className="text-sm text-ink-500">
        この取り込みは確認できません。
        <Link to="/import" className="underline underline-offset-4">
          取り込みに戻る
        </Link>
      </p>
    );
  }

  const setRow = (i: number, patch: Partial<Row>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const setCell = (i: number, day: number, symbol: string) =>
    setRow(i, { cells: { ...rows[i].cells, [day]: symbol } });
  const setTarget = (i: number, value: string) => {
    const r = rows[i];
    const target: Target =
      value === "skip"
        ? { type: "skip" }
        : value === "new"
          ? { type: "new", name: r.readName }
          : { type: "member", memberId: value.slice(2), rememberAlias: true };
    setRow(i, { target });
  };

  const isKnownName = (r: Row) => {
    if (r.target.type !== "member") return true;
    const m = members.find((x) => x.id === (r.target as { memberId: string }).memberId);
    return !!m && [m.name, ...m.aliases].some((n) => normalizeName(n) === normalizeName(r.readName));
  };

  const commit = async () => {
    setError("");
    const body: CommitInput = {
      yearMonth,
      rows: rows.map((r) => ({
        readName: r.readName,
        target: r.target,
        cells: Object.entries(r.cells)
          .map(([day, symbol]) => ({ day: Number(day), symbol: normalizeSymbol(symbol) }))
          .filter((c) => c.symbol !== "" && days.includes(c.day)),
      })),
    };
    const ok = await run(async () => {
      try {
        await api(`/imports/${id}/commit`, { body });
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) membersRes.reload();
        throw e;
      }
    });
    if (ok) navigate(`/?m=${yearMonth}`);
  };

  const ready = /^\d{4}-\d{2}$/.test(yearMonth) && unknownSymbols.length === 0;

  return (
    <div>
      <div className="grid gap-3">
        {/* 元の画像 (タップで原寸表示) */}
        <a href={`/api/imports/${id}/image`} target="_blank" rel="noreferrer" className="inline-block max-w-full">
          <img
            src={`/api/imports/${id}/image`}
            alt="取り込んだシフト表"
            className="max-h-40 max-w-full rounded-sm border border-ink-100 md:max-h-60"
          />
        </a>

        <div className="min-w-0">
          <div className="flex flex-wrap items-end gap-2 pb-2">
            <div className="w-25">
              <Field label="年月" id="yearMonth">
                <TextInput id="yearMonth" type="month" value={yearMonth} onChange={(e) => setYearMonth(e.target.value)} />
              </Field>
            </div>
          </div>
          {!yearMonth && <Hint>年月を読み取れませんでした。入力してください</Hint>}
          {result.notes && <Hint>読み取りメモ: {result.notes}</Hint>}

          {/* 行=人、列=日 の表。名前の列は横スクロールしても固定 */}
          <div className="mt-2 overflow-x-auto border-t border-ink-100">
            <table className="border-separate border-spacing-0 text-sm">
              <thead>
                <tr>
                  <th className="sticky left-0 z-10 w-15 min-w-15 bg-white py-1 pr-2 text-left md:w-20 md:min-w-20 text-xs font-normal text-ink-500">
                    名前
                  </th>
                  {days.map((d) => (
                    <th key={d} className="w-5 min-w-5 py-1 text-center text-xs font-normal text-ink-500">
                      {d}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const skipped = r.target.type === "skip";
                  return (
                    <tr key={i} className={skipped ? "text-ink-300" : ""}>
                      <td className="sticky left-0 z-10 border-t border-ink-100 bg-white py-1 pr-2 align-top">
                        <p className="truncate text-xs text-ink-500">{r.readName}</p>
                        <select
                          aria-label={`${r.readName} の取り込み先`}
                          value={targetValue(r.target)}
                          onChange={(e) => setTarget(i, e.target.value)}
                          className={COMPACT}
                        >
                          {members.map((m) => (
                            <option key={m.id} value={`m:${m.id}`}>
                              {m.name}
                            </option>
                          ))}
                          <option value="new">新規メンバー</option>
                          <option value="skip">取り込まない</option>
                        </select>
                        {r.target.type === "new" && (
                          <input
                            aria-label="新しいメンバーの名前"
                            value={r.target.name}
                            maxLength={40}
                            onChange={(e) => setRow(i, { target: { type: "new", name: e.target.value } })}
                            className={`mt-1 ${COMPACT}`}
                          />
                        )}
                        {r.target.type === "member" && !isKnownName(r) && (
                          <div className="pt-1">
                            <Checkbox
                              label="別名として覚える"
                              checked={r.target.rememberAlias}
                              onChange={(e) =>
                                setRow(i, { target: { ...(r.target as Extract<Target, { type: "member" }>), rememberAlias: e.target.checked } })
                              }
                            />
                          </div>
                        )}
                      </td>
                      {days.map((d) => {
                        const symbol = r.cells[d] ?? "";
                        const code = symbol ? matchCode(symbol, codes) : null;
                        const unknown = !skipped && symbol.trim() !== "" && !code;
                        return (
                          <td key={d} className="border-t border-ink-100 p-0 align-top">
                            <input
                              aria-label={`${r.readName} ${d}日`}
                              value={symbol}
                              maxLength={8}
                              disabled={skipped}
                              onChange={(e) => setCell(i, d, e.target.value)}
                              className={`mt-1 h-4 w-5 rounded-sm text-center text-sm outline-none focus:ring-1 focus:ring-ink-900 ${
                                unknown
                                  ? "bg-ink-900 text-white"
                                  : code?.isOff
                                    ? "bg-white text-ink-300"
                                    : "bg-white text-ink-900"
                              }`}
                            />
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {unknownSymbols.length > 0 && (
            <Section title="記号表に無い記号">
              <div className="border-t border-ink-100">
                {unknownSymbols.map((s) => (
                  <AddCodeInline key={s} symbol={s} onAdded={codesRes.reload} />
                ))}
              </div>
              <Hint>記号表に追加するか、表のセルを書き直してください</Hint>
            </Section>
          )}

          <div className="flex items-center gap-2 pt-3">
            <Button onClick={commit} disabled={busy || !ready}>
              <Check {...ICON_PROPS} />
              この内容で保存
            </Button>
            <Link to="/import" className="text-sm text-ink-500">
              あとで
            </Link>
          </div>
          <ErrorText>{error}</ErrorText>
        </div>
      </div>
    </div>
  );
}
