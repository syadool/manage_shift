import { describe, expect, it } from "vitest";
import { call, createUser } from "./helpers";

describe("認証が必要", () => {
  it.each(["/settings", "/shift-codes", "/members"])("%s は未ログインで 401", async (path) => {
    expect((await call(null, "GET", path)).status).toBe(401);
  });
  it("ログイン系 API は未ログインでも使える", async () => {
    expect((await call(null, "POST", "/auth/login/options", {})).status).toBe(200);
  });
  it("別オリジンからの変更は 403", async () => {
    const { cookie } = await createUser();
    const { exports } = await import("cloudflare:workers");
    const res = await exports.default.fetch(
      new Request("https://shift.test/api/members", {
        method: "POST",
        headers: { Origin: "https://evil.test", Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "x", aliases: [], isMe: false }),
      }),
    );
    expect(res.status).toBe(403);
  });
});

describe("設定", () => {
  it("初期値を返し、保存できる", async () => {
    const { cookie } = await createUser();
    const initial = await call(cookie, "GET", "/settings");
    expect(initial.data.settings).toMatchObject({ hourlyWage: 0, incomeWallYen: null });

    const input = {
      hourlyWage: 1200,
      transportPerDay: 400,
      incomeWallYen: 1_300_000,
      wallLabel: "扶養",
      includeTransportInWall: false,
    };
    expect((await call(cookie, "PUT", "/settings", input)).status).toBe(200);
    expect((await call(cookie, "GET", "/settings")).data.settings).toEqual(input);
  });

  it("不正な値は 400 とメッセージ", async () => {
    const { cookie } = await createUser();
    const r = await call(cookie, "PUT", "/settings", {
      hourlyWage: -1,
      transportPerDay: 0,
      incomeWallYen: null,
      wallLabel: null,
      includeTransportInWall: false,
    });
    expect(r.status).toBe(400);
    expect(r.data.error).toContain("時給");
  });
});

describe("記号の対応表", () => {
  it("追加・更新・削除、重複は 409、休みは時刻を消す", async () => {
    const { cookie } = await createUser();
    const a = await call(cookie, "POST", "/shift-codes", {
      symbol: "A",
      isOff: false,
      startTime: "09:00",
      endTime: "17:00",
      breakMinutes: 60,
    });
    expect(a.status).toBe(201);

    const dup = await call(cookie, "POST", "/shift-codes", {
      symbol: "A",
      isOff: true,
      startTime: null,
      endTime: null,
      breakMinutes: 0,
    });
    expect(dup.status).toBe(409);

    const off = await call(cookie, "POST", "/shift-codes", {
      symbol: "×",
      isOff: true,
      startTime: "09:00",
      endTime: "10:00",
      breakMinutes: 30,
    });
    expect(off.data.shiftCode).toMatchObject({ startTime: null, endTime: null, breakMinutes: 0 });

    const missing = await call(cookie, "POST", "/shift-codes", {
      symbol: "B",
      isOff: false,
      startTime: null,
      endTime: null,
      breakMinutes: 0,
    });
    expect(missing.status).toBe(400);

    const upd = await call(cookie, "PUT", `/shift-codes/${a.data.shiftCode.id}`, {
      symbol: "A",
      isOff: false,
      startTime: "22:00",
      endTime: "05:00",
      breakMinutes: 0,
    });
    expect(upd.data.shiftCode.endTime).toBe("05:00");

    expect((await call(cookie, "DELETE", `/shift-codes/${a.data.shiftCode.id}`)).status).toBe(200);
    expect((await call(cookie, "GET", "/shift-codes")).data.shiftCodes.map((s: any) => s.symbol)).toEqual(["×"]);
  });

  it("他ユーザーの記号は見えず、変更もできない", async () => {
    const u1 = await createUser();
    const u2 = await createUser();
    const a = await call(u1.cookie, "POST", "/shift-codes", {
      symbol: "A",
      isOff: true,
      startTime: null,
      endTime: null,
      breakMinutes: 0,
    });
    expect((await call(u2.cookie, "GET", "/shift-codes")).data.shiftCodes).toEqual([]);
    expect((await call(u2.cookie, "DELETE", `/shift-codes/${a.data.shiftCode.id}`)).status).toBe(404);
    // 別ユーザーなら同じ記号を使える
    expect(
      (await call(u2.cookie, "POST", "/shift-codes", {
        symbol: "A",
        isOff: true,
        startTime: null,
        endTime: null,
        breakMinutes: 0,
      })).status,
    ).toBe(201);
  });
});

describe("メンバー", () => {
  it("自分は1人だけ", async () => {
    const { cookie } = await createUser();
    const a = await call(cookie, "POST", "/members", { name: "山田", aliases: [], isMe: true });
    const b = await call(cookie, "POST", "/members", { name: "佐藤", aliases: [], isMe: true });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    const list = (await call(cookie, "GET", "/members")).data.members;
    expect(list.filter((m: any) => m.isMe).map((m: any) => m.name)).toEqual(["佐藤"]);
    expect(list[0].name).toBe("佐藤"); // 自分が先頭
  });

  it("名前・別名の重複は表記ゆれも含めて 409", async () => {
    const { cookie } = await createUser();
    await call(cookie, "POST", "/members", { name: "山田 太郎", aliases: ["ﾔﾏﾀﾞ"], isMe: false });
    const r1 = await call(cookie, "POST", "/members", { name: "山田太郎", aliases: [], isMe: false });
    expect(r1.status).toBe(409);
    const r2 = await call(cookie, "POST", "/members", { name: "別人", aliases: ["ヤマダ"], isMe: false });
    expect(r2.status).toBe(409);
    expect(r2.data.error).toContain("山田 太郎");
  });

  it("存在しないメンバーを isMe で更新しても、今の「自分」は外れない", async () => {
    const { cookie } = await createUser();
    const me = await call(cookie, "POST", "/members", { name: "自分", aliases: [], isMe: true });
    const r = await call(cookie, "PUT", "/members/does-not-exist", { name: "誰か", aliases: [], isMe: true });
    expect(r.status).toBe(404);
    const list = (await call(cookie, "GET", "/members")).data.members;
    expect(list.find((m: any) => m.id === me.data.member.id).isMe).toBe(true);
  });

  it("他ユーザーのメンバーを isMe で更新しても、自分の「自分」は外れない", async () => {
    const a = await createUser();
    const b = await createUser();
    const aMe = await call(a.cookie, "POST", "/members", { name: "A", aliases: [], isMe: true });
    const bMe = await call(b.cookie, "POST", "/members", { name: "B", aliases: [], isMe: true });
    const r = await call(a.cookie, "PUT", `/members/${bMe.data.member.id}`, { name: "X", aliases: [], isMe: true });
    expect(r.status).toBe(404);
    expect((await call(a.cookie, "GET", "/members")).data.members[0]).toMatchObject({ id: aMe.data.member.id, isMe: true });
    expect((await call(b.cookie, "GET", "/members")).data.members[0]).toMatchObject({ name: "B", isMe: true });
  });

  it("自分自身の名前は更新時に重複扱いしない", async () => {
    const { cookie } = await createUser();
    const a = await call(cookie, "POST", "/members", { name: "鈴木", aliases: [], isMe: false });
    const r = await call(cookie, "PUT", `/members/${a.data.member.id}`, {
      name: "鈴木",
      aliases: ["すずき", "すずき"],
      isMe: false,
    });
    expect(r.status).toBe(200);
    expect(r.data.member.aliases).toEqual(["すずき"]);
  });
});

describe("メンバー名の一意性 (DB 制約)", () => {
  it("同じ名前の同時作成は1件だけ成功する", async () => {
    const { cookie } = await createUser();
    const results = await Promise.all(
      ["山田 太郎", "山田太郎", "ﾔﾏﾀﾞﾀﾛｳ", "やまだ"].map((name, i) =>
        call(cookie, "POST", "/members", {
          name: i === 3 ? "別名で衝突" : name,
          aliases: i === 2 ? [] : i === 3 ? ["山田太郎"] : [],
          isMe: false,
        }),
      ),
    );
    const statuses = results.map((r) => r.status).sort();
    // 「山田 太郎」「山田太郎」「別名: 山田太郎」は同じ名前。「ﾔﾏﾀﾞﾀﾛｳ」は別
    expect(statuses.filter((s) => s === 201)).toHaveLength(2);
    expect(statuses.filter((s) => s === 409)).toHaveLength(2);
    const names = (await call(cookie, "GET", "/members")).data.members.map((m: any) => m.name);
    expect(names).toHaveLength(2);
    expect(names).toContain("ﾔﾏﾀﾞﾀﾛｳ");
  });

  it("事前チェックをすり抜けても、DB の一意制約で 409 になる", async () => {
    const { env } = await import("cloudflare:workers");
    const { cookie, userId } = await createUser();
    // findNameConflict が見る members には無いが、member_names には既にある状態を作る
    const ghost = (await call(cookie, "POST", "/members", { name: "幽霊", aliases: [], isMe: false })).data.member;
    await env.DB.prepare("update members set name = '別人', aliases = '[]' where id = ?").bind(ghost.id).run();
    const r = await call(cookie, "POST", "/members", { name: "幽霊", aliases: [], isMe: true });
    expect(r.status).toBe(409);
    // 失敗したトランザクションは何も残さない (members も増えず、isMe も変わらない)
    const count = await env.DB.prepare("select count(*) as n from members where user_id = ?").bind(userId).first("n");
    expect(count).toBe(1);
  });

  it("名前を変えると古い名前は解放され、別のメンバーで使える", async () => {
    const { cookie } = await createUser();
    const a = (await call(cookie, "POST", "/members", { name: "佐藤", aliases: ["さとう"], isMe: false })).data.member;
    await call(cookie, "PUT", `/members/${a.id}`, { name: "佐藤 花子", aliases: [], isMe: false });
    expect((await call(cookie, "POST", "/members", { name: "さとう", aliases: [], isMe: false })).status).toBe(201);
  });

  it("メンバーを削除すると名前は解放される", async () => {
    const { cookie } = await createUser();
    const a = (await call(cookie, "POST", "/members", { name: "鈴木", aliases: [], isMe: false })).data.member;
    await call(cookie, "DELETE", `/members/${a.id}`);
    expect((await call(cookie, "POST", "/members", { name: "鈴木", aliases: [], isMe: false })).status).toBe(201);
  });

  it("名前と別名が正規化後に同じでも、自分自身とは衝突しない", async () => {
    const { cookie } = await createUser();
    const r = await call(cookie, "POST", "/members", { name: "高橋", aliases: ["高 橋", "ﾀｶﾊｼ", "タカハシ"], isMe: false });
    expect(r.status).toBe(201);
  });

  it("別ユーザーなら同じ名前を使える", async () => {
    const a = await createUser();
    const b = await createUser();
    expect((await call(a.cookie, "POST", "/members", { name: "田中", aliases: [], isMe: false })).status).toBe(201);
    expect((await call(b.cookie, "POST", "/members", { name: "田中", aliases: [], isMe: false })).status).toBe(201);
  });
});
