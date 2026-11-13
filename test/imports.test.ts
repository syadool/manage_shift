import { afterEach, describe, expect, it } from "vitest";
import { env, exports } from "cloudflare:workers";
import { ocr, ExtractError } from "../src/worker/ocr/extract";
import { cleanExtraction, matchCode, matchMember, type Extraction } from "../src/shared/importing";
import { sniffImageType, MAX_PARSE_ATTEMPTS } from "../src/worker/routes/imports";
import { call, createUser, ORIGIN } from "./helpers";

const realExtract = ocr.extract;
afterEach(() => {
  ocr.extract = realExtract;
});

/** 1x1 の PNG */
const PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="),
  (c) => c.charCodeAt(0),
);

async function upload(cookie: string, bytes: Uint8Array = PNG, name = "shift.png") {
  const form = new FormData();
  form.append("image", new File([bytes], name, { type: "image/png" }));
  const res = await exports.default.fetch(
    new Request(`${ORIGIN}/api/imports`, { method: "POST", headers: { Origin: ORIGIN, Cookie: cookie }, body: form }),
  );
  return { status: res.status, data: (await res.json()) as any };
}

async function setup() {
  const u = await createUser();
  const post = (path: string, body: unknown) => call(u.cookie, "POST", path, body);
  const me = (await post("/members", { name: "山田 太郎", aliases: [], isMe: true })).data.member;
  const sato = (await post("/members", { name: "佐藤 花子", aliases: [], isMe: false })).data.member;
  await post("/shift-codes", { symbol: "A", isOff: false, startTime: "09:00", endTime: "17:00", breakMinutes: 60 });
  await post("/shift-codes", { symbol: "N", isOff: false, startTime: "22:00", endTime: "05:00", breakMinutes: 0 });
  await post("/shift-codes", { symbol: "×", isOff: true, startTime: null, endTime: null, breakMinutes: 0 });
  return { ...u, me, sato };
}

const EXTRACTION: Extraction = {
  yearMonth: "2026-12",
  notes: "",
  rows: [
    { name: "山田太郎", cells: [{ day: 1, symbol: "A" }, { day: 2, symbol: "×" }, { day: 3, symbol: "Ｎ" }] },
    { name: "ｻﾄｳ", cells: [{ day: 1, symbol: "A" }, { day: 2, symbol: "" }] },
    { name: "新人 次郎", cells: [{ day: 3, symbol: "A" }] },
  ],
};

async function parsed(cookie: string, result: Extraction = EXTRACTION) {
  ocr.extract = async () => result;
  const up = await upload(cookie);
  const p = await call(cookie, "POST", `/imports/${up.data.import.id}/parse`, {});
  return { id: up.data.import.id as string, parse: p };
}

describe("ユーティリティ", () => {
  it("画像の種類はファイル先頭のバイトで判定する", () => {
    expect(sniffImageType(PNG)).toBe("image/png");
    expect(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffImageType(new TextEncoder().encode("<svg xmlns="))).toBeNull();
  });

  it("読み取り結果を整える", () => {
    const r = cleanExtraction({
      yearMonth: "2026-13",
      notes: "",
      rows: [
        { name: " 山田 ", cells: [{ day: 3, symbol: " A " }, { day: 0, symbol: "A" }, { day: 1, symbol: "B" }, { day: 1, symbol: "C" }] },
        { name: "  ", cells: [] },
      ],
    });
    expect(r.yearMonth).toBeNull();
    expect(r.rows).toEqual([{ name: "山田", cells: [{ day: 1, symbol: "B" }, { day: 3, symbol: "A" }] }]);
  });

  it("名前と記号の照合は表記ゆれを吸収する", () => {
    const members = [{ id: "1", name: "佐藤 花子", aliases: ["サトウ"] }];
    expect(matchMember("佐藤花子", members)?.id).toBe("1");
    expect(matchMember("ｻﾄｳ", members)?.id).toBe("1");
    expect(matchMember("鈴木", members)).toBeNull();
    const codes = [{ id: "a", symbol: "A", isOff: false }];
    expect(matchCode("Ａ", codes)?.id).toBe("a");
    expect(matchCode(" A ", codes)?.id).toBe("a");
    expect(matchCode("a", codes)).toBeNull();
  });
});

describe("アップロード", () => {
  it("画像を R2 に保存し、本人だけが取得できる", async () => {
    const a = await createUser();
    const b = await createUser();
    const up = await upload(a.cookie);
    expect(up.status).toBe(201);
    expect(up.data.import.status).toBe("uploaded");
    const img = await exports.default.fetch(
      new Request(`${ORIGIN}/api/imports/${up.data.import.id}/image`, { headers: { Cookie: a.cookie } }),
    );
    expect(img.status).toBe(200);
    expect(img.headers.get("Content-Type")).toBe("image/png");
    expect(new Uint8Array(await img.arrayBuffer())).toEqual(PNG);
    const other = await exports.default.fetch(
      new Request(`${ORIGIN}/api/imports/${up.data.import.id}/image`, { headers: { Cookie: b.cookie } }),
    );
    expect(other.status).toBe(404);
  });

  it("画像以外は拒否する (拡張子や Content-Type ではなく中身で判定)", async () => {
    const { cookie } = await createUser();
    const r = await upload(cookie, new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"), "x.png");
    expect(r.status).toBe(400);
  });

  it("1日の枚数に上限がある", async () => {
    const { cookie, userId } = await createUser();
    const stmt = env.DB.prepare(
      "insert into imports (id, user_id, r2_key, status) values (?, ?, 'k', 'uploaded')",
    );
    await env.DB.batch(Array.from({ length: 20 }, () => stmt.bind(crypto.randomUUID(), userId)));
    expect((await upload(cookie)).status).toBe(429);
  });
});

describe("読み取り", () => {
  it("結果を保存し、登録済みの記号と名前をヒントとして渡す", async () => {
    const { cookie } = await setup();
    let received: any;
    ocr.extract = async (_env, input) => {
      received = input;
      return EXTRACTION;
    };
    const up = await upload(cookie);
    const p = await call(cookie, "POST", `/imports/${up.data.import.id}/parse`, {});
    expect(p.status).toBe(200);
    expect(p.data.import).toMatchObject({ status: "parsed", targetMonth: "2026-12", parseAttempts: 1 });
    expect(received.mediaType).toBe("image/png");
    expect(received.knownSymbols.sort()).toEqual(["A", "N", "×"].sort());
    expect(received.knownNames).toContain("佐藤 花子");
    const got = await call(cookie, "GET", `/imports/${up.data.import.id}`);
    expect(got.data.result.rows).toHaveLength(3);
  });

  it("失敗は理由を記録し、回数の上限まで再試行できる", async () => {
    const { cookie } = await setup();
    ocr.extract = async () => {
      throw new ExtractError("混み合っています");
    };
    const up = await upload(cookie);
    const path = `/imports/${up.data.import.id}/parse`;
    for (let i = 0; i < MAX_PARSE_ATTEMPTS; i++) {
      const r = await call(cookie, "POST", path, {});
      expect(r.status).toBe(502);
      expect(r.data.error).toBe("混み合っています");
    }
    expect((await call(cookie, "POST", path, {})).status).toBe(429);
    expect((await call(cookie, "GET", `/imports/${up.data.import.id}`)).data.import).toMatchObject({
      status: "failed",
      error: "混み合っています",
    });
  });

  it("他ユーザーの取り込みは読み取れない", async () => {
    const a = await setup();
    const b = await createUser();
    const up = await upload(a.cookie);
    expect((await call(b.cookie, "POST", `/imports/${up.data.import.id}/parse`, {})).status).toBe(404);
    expect((await call(b.cookie, "GET", `/imports/${up.data.import.id}`)).status).toBe(404);
  });
});

describe("確定", () => {
  const commitBody = (me: any, sato: any) => ({
    yearMonth: "2026-12",
    rows: [
      { readName: "山田太郎", target: { type: "member", memberId: me.id, rememberAlias: true }, cells: EXTRACTION.rows[0].cells },
      { readName: "ｻﾄｳ", target: { type: "member", memberId: sato.id, rememberAlias: true }, cells: EXTRACTION.rows[1].cells },
      { readName: "新人 次郎", target: { type: "new", name: "新人 次郎" }, cells: EXTRACTION.rows[2].cells },
    ],
  });

  it("勤務の記号だけシフトになり、新しいメンバーと別名が登録される", async () => {
    const { cookie, me, sato } = await setup();
    const { id } = await parsed(cookie);
    const r = await call(cookie, "POST", `/imports/${id}/commit`, commitBody(me, sato));
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ created: 4, members: 3 });

    const list = (await call(cookie, "GET", "/shifts?from=2026-12-01&to=2026-12-31")).data.shifts;
    const mine = list.filter((s: any) => s.memberId === me.id);
    expect(mine.map((s: any) => [s.date, s.startTime, s.endTime, s.source])).toEqual([
      ["2026-12-01", "09:00", "17:00", "ocr"],
      ["2026-12-03", "22:00", "05:00", "ocr"], // 全角の Ｎ も N として扱う
    ]);
    const members = (await call(cookie, "GET", "/members")).data.members;
    expect(members.find((m: any) => m.id === sato.id).aliases).toEqual(["ｻﾄｳ"]);
    expect(members.find((m: any) => m.name === "新人 次郎")).toBeTruthy();
    // 「山田太郎」は「山田 太郎」と同じ名前なので別名には足さない
    expect(members.find((m: any) => m.id === me.id).aliases).toEqual([]);
    // 確定後は再確定・再読み取りできない
    expect((await call(cookie, "POST", `/imports/${id}/commit`, commitBody(me, sato))).status).toBe(409);
    expect((await call(cookie, "POST", `/imports/${id}/parse`, {})).status).toBe(409);
  });

  it("同じ月を取り込み直すと画像由来のシフトだけ置き換え、手入力のシフトは残す", async () => {
    const { cookie, me, sato } = await setup();
    const manual = (
      await call(cookie, "POST", "/shifts", {
        memberId: me.id, date: "2026-12-10", shiftCodeId: null, startTime: "10:00", endTime: "12:00", breakMinutes: 0,
      })
    ).data.shift;
    const first = await parsed(cookie);
    await call(cookie, "POST", `/imports/${first.id}/commit`, commitBody(me, sato));

    const second = await parsed(cookie, {
      yearMonth: "2026-12",
      notes: "",
      rows: [{ name: "山田太郎", cells: [{ day: 5, symbol: "A" }] }],
    });
    const r = await call(cookie, "POST", `/imports/${second.id}/commit`, {
      yearMonth: "2026-12",
      rows: [{ readName: "山田太郎", target: { type: "member", memberId: me.id, rememberAlias: false }, cells: [{ day: 5, symbol: "A" }] }],
    });
    expect(r.status).toBe(200);
    const mine = (await call(cookie, "GET", "/shifts?from=2026-12-01&to=2026-12-31")).data.shifts.filter(
      (s: any) => s.memberId === me.id,
    );
    expect(mine.map((s: any) => [s.date, s.source])).toEqual([
      ["2026-12-05", "ocr"],
      ["2026-12-10", "manual"],
    ]);
    expect(mine.find((s: any) => s.source === "manual").id).toBe(manual.id);
    // 2回目に含めなかった佐藤さんの分は残る
    const satoShifts = (await call(cookie, "GET", "/shifts?from=2026-12-01&to=2026-12-31")).data.shifts.filter(
      (s: any) => s.memberId === sato.id,
    );
    expect(satoShifts).toHaveLength(1);
  });

  it("記号表に無い記号があれば何も保存しない", async () => {
    const { cookie, me, sato } = await setup();
    const { id } = await parsed(cookie);
    const body = commitBody(me, sato);
    body.rows[0].cells = [{ day: 1, symbol: "Z" }];
    const r = await call(cookie, "POST", `/imports/${id}/commit`, body);
    expect(r.status).toBe(400);
    expect(r.data.unknownSymbols).toEqual(["Z"]);
    expect((await call(cookie, "GET", "/shifts?from=2026-12-01&to=2026-12-31")).data.shifts).toEqual([]);
    expect((await call(cookie, "GET", "/members")).data.members).toHaveLength(2);
  });

  it("「取り込まない」行は無視し、存在しない日 (11月31日など) は飛ばす", async () => {
    const { cookie, me, sato } = await setup();
    const { id } = await parsed(cookie);
    const r = await call(cookie, "POST", `/imports/${id}/commit`, {
      yearMonth: "2026-11",
      rows: [
        { readName: "山田太郎", target: { type: "member", memberId: me.id, rememberAlias: false }, cells: [{ day: 30, symbol: "A" }, { day: 31, symbol: "A" }] },
        { readName: "ｻﾄｳ", target: { type: "skip" }, cells: [{ day: 1, symbol: "A" }] },
      ],
    });
    expect(r.data).toMatchObject({ created: 1, members: 1 });
    void sato;
  });

  it("同じメンバーへの重複、他ユーザーのメンバー、既存と同じ名前の新規は拒否する", async () => {
    const a = await setup();
    const b = await setup();
    const { id } = await parsed(a.cookie);
    const row = (memberId: string) => ({ readName: "x", target: { type: "member", memberId, rememberAlias: false }, cells: [] });
    expect(
      (await call(a.cookie, "POST", `/imports/${id}/commit`, { yearMonth: "2026-12", rows: [row(a.me.id), row(a.me.id)] })).status,
    ).toBe(400);
    expect(
      (await call(a.cookie, "POST", `/imports/${id}/commit`, { yearMonth: "2026-12", rows: [row(b.me.id)] })).status,
    ).toBe(400);
    const dup = await call(a.cookie, "POST", `/imports/${id}/commit`, {
      yearMonth: "2026-12",
      rows: [{ readName: "佐藤花子", target: { type: "new", name: "佐藤花子" }, cells: [{ day: 1, symbol: "A" }] }],
    });
    expect(dup.status).toBe(409);
    // b のデータには何も起きていない
    expect((await call(b.cookie, "GET", "/shifts?from=2026-12-01&to=2026-12-31")).data.shifts).toEqual([]);
  });
});
