import { useCallback, useEffect, useState } from "react";
import { api } from "./api";

/** GET して state に持つ。reload で再取得 */
export function useResource<T>(path: string) {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState("");
  const reload = useCallback(() => {
    api<T>(path)
      .then((d) => {
        setData(d);
        setError("");
      })
      .catch((e: Error) => setError(e.message));
  }, [path]);
  useEffect(reload, [reload]);
  return { data, error, reload, setData };
}

/** 非同期操作の実行中フラグとエラー文言をまとめて扱う */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "エラーが発生しました");
      return false;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run, setError };
}
