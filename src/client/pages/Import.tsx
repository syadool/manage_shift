import { useRef, useState } from "react";
import { ImageUp } from "lucide-react";
import { Link, useNavigate } from "react-router";
import { api, ApiError } from "../lib/api";
import { useResource } from "../lib/useResource";
import { ICON_PROPS } from "../components/Layout";
import { Button, ErrorText, Hint, LoadError, Section } from "../components/ui";

type ImportSummary = {
  id: string;
  status: "uploaded" | "parsed" | "committing" | "committed" | "failed";
  targetMonth: string | null;
  parseAttempts: number;
  error: string | null;
  createdAt: string;
};

const STATUS_LABEL: Record<ImportSummary["status"], string> = {
  uploaded: "未読み取り",
  parsed: "確認待ち",
  committing: "保存中",
  committed: "確定済み",
  failed: "失敗",
};

/** 長辺を最大 2000px に縮小して JPEG にする (送信量と読み取り費用を抑える) */
async function shrink(file: File): Promise<Blob> {
  const MAX = 2000;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("この形式の画像は読み込めません。JPEG か PNG で保存し直してください");
  }
  const scale = Math.min(1, MAX / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#ffffff"; // 透過 PNG の背景を白にする
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("画像の変換に失敗しました"))), "image/jpeg", 0.9),
  );
}

async function uploadImage(blob: Blob): Promise<ImportSummary> {
  const form = new FormData();
  form.append("image", blob, "shift.jpg");
  const res = await fetch("/api/imports", { method: "POST", body: form, credentials: "same-origin" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? "アップロードに失敗しました");
  return data.import;
}

const fmtDate = (iso: string) => new Date(iso).toLocaleString("ja-JP", { dateStyle: "short", timeStyle: "short" });
const fmtMonth = (m: string | null) => (m ? `${Number(m.slice(0, 4))}年${Number(m.slice(5, 7))}月` : "年月不明");

export function Import() {
  const navigate = useNavigate();
  const fileRef = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<"idle" | "uploading" | "reading">("idle");
  const [error, setError] = useState("");
  const history = useResource<{ imports: ImportSummary[] }>("/imports");

  const parse = async (id: string) => {
    setPhase("reading");
    setError("");
    try {
      await api(`/imports/${id}/parse`, { body: {} });
      navigate(`/import/${id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "読み取りに失敗しました");
      history.reload();
    } finally {
      setPhase("idle");
    }
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setError("");
    setPhase("uploading");
    let imported: ImportSummary;
    try {
      imported = await uploadImage(await shrink(file));
    } catch (e) {
      setError(e instanceof Error ? e.message : "アップロードに失敗しました");
      setPhase("idle");
      return;
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
    await parse(imported.id);
  };

  const busy = phase !== "idle";

  return (
    <div className="max-w-xl">
      <Section title="シフト表の画像">
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => onFile(e.target.files?.[0])}
        />
        <Button onClick={() => fileRef.current?.click()} disabled={busy}>
          <ImageUp {...ICON_PROPS} />
          画像を選ぶ
        </Button>
        {phase === "uploading" && <p className="pt-2 text-sm text-ink-500">アップロード中…</p>}
        {phase === "reading" && <p className="pt-2 text-sm text-ink-500">読み取り中… (1分ほどかかることがあります)</p>}
        <ErrorText>{error}</ErrorText>
        <Hint>行が人、列が日付の表を読み取ります。読み取り後に内容を確認・修正してから保存します</Hint>
      </Section>

      <Section title="履歴">
        {history.error && <LoadError message={history.error} onRetry={history.reload} />}
        <ul className="border-t border-ink-100">
          {history.data?.imports.map((im) => (
            <li key={im.id} className="flex items-center gap-2 border-b border-ink-100 py-1">
              <div className="min-w-0 flex-1">
                <p className="text-sm">{fmtMonth(im.targetMonth)}</p>
                <p className="truncate text-xs text-ink-500">
                  {fmtDate(im.createdAt)} ・ {STATUS_LABEL[im.status]}
                  {im.status === "failed" && im.error ? ` ・ ${im.error}` : ""}
                </p>
              </div>
              {im.status === "parsed" && (
                <Link to={`/import/${im.id}`} className="text-sm text-ink-900 underline underline-offset-4">
                  確認する
                </Link>
              )}
              {(im.status === "failed" || im.status === "uploaded") && im.parseAttempts < 3 && (
                <Button variant="ghost" onClick={() => parse(im.id)} disabled={busy}>
                  再読み取り
                </Button>
              )}
            </li>
          ))}
        </ul>
        {history.data && history.data.imports.length === 0 && <p className="py-2 text-sm text-ink-500">まだありません</p>}
      </Section>
    </div>
  );
}
