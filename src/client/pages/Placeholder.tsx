/** 各画面の実装までの仮置き。見出しは機能名のみ */
export function Placeholder({ label }: { label: string }) {
  return <p className="text-sm text-ink-500">{label}（未実装）</p>;
}
