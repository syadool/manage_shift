import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";

/**
 * GET して state に持つ。reload で再取得。
 * path を素早く切り替えたとき、古い path の応答が後から届いて上書きしないよう、
 * 最後に出した要求の応答だけを反映する。path が変わったら前のデータは消す
 */
export function useResource<T>(path: string) {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const reload = useCallback(() => {
    const gen = ++generation.current;
    api<T>(path)
      .then((d) => {
        if (gen !== generation.current) return;
        setData(d);
        setError("");
      })
      .catch((e: Error) => {
        if (gen === generation.current) setError(e.message);
      });
  }, [path]);
  useEffect(() => {
    // 別の期間などに切り替えたら、前の内容を表示し続けない
    setData(undefined);
    setError("");
    reload();
  }, [reload]);
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
