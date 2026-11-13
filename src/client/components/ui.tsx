import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";

/**
 * 共通 UI。デザインルール:
 * 黒の単色 / 余白は 8 の倍数 / 強弱は濃淡 / カードは控えめ / 線アイコン
 *
 * 文字の左端揃え: 枠付きボタンは内側余白 (px-2) と同じだけ左へはみ出させ (-ml-2)、
 * ボタン内の先頭 (アイコン/文字) が本文の左端と同じ縦ラインに来るようにする。
 */

export function Button({
  variant = "primary",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" }) {
  const styles = {
    primary: "bg-ink-900 text-white disabled:bg-ink-300",
    secondary: "border border-ink-300 text-ink-900 disabled:text-ink-300",
    ghost: "text-ink-500 hover:text-ink-900 disabled:text-ink-300",
  }[variant];
  return (
    <button
      className={`inline-flex h-5 items-center gap-1 rounded-sm text-sm ${variant === "ghost" ? "" : "-ml-2 px-2"} ${styles} ${className}`}
      {...props}
    />
  );
}

export function TextInput({ className = "", ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`h-5 w-full rounded-sm border border-ink-300 px-1 text-base outline-none focus:border-ink-900 ${className}`}
      {...props}
    />
  );
}

export function Label({ children, htmlFor }: { children: ReactNode; htmlFor?: string }) {
  return (
    <label htmlFor={htmlFor} className="block pb-1 text-xs text-ink-500">
      {children}
    </label>
  );
}

/** セクション見出し。機能名のみ */
export function SectionHeading({ children }: { children: ReactNode }) {
  return <h2 className="pb-2 text-sm text-ink-500">{children}</h2>;
}

export function ErrorText({ children }: { children: ReactNode }) {
  return children ? (
    <p role="alert" className="pt-1 text-sm text-ink-900">
      {children}
    </p>
  ) : null;
}
