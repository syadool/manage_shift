/**
 * 名前の照合用正規化。OCR の表記ゆれ (全角/半角、空白の有無、大文字小文字) を吸収する
 */
export function normalizeName(name: string): string {
  return name.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
}
