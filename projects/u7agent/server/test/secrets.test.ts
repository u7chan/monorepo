// 作業フォルダ単位の環境変数ストア (server/src/secrets.ts) の単体テスト。メモリ DB とダミー値だけを使う。
import assert from "node:assert/strict";
import test from "node:test";
import { AppDb } from "../src/app-db";
import { createSecretCipher, parseMasterKeys, SECRET_KEY_BYTES } from "../src/secret-crypto";
import {
  createSecretScope,
  SECRET_VALUE_MAX_BYTES,
  SecretService,
  secretGeneration,
  VARIABLE_VALUE_MAX_LENGTH,
  type SecretScope,
  type SecretStore,
} from "../src/secrets";

const KEY = Buffer.alloc(SECRET_KEY_BYTES, 7).toString("base64");

function statusOf(error: unknown): number | undefined {
  return (error as { statusCode?: number }).statusCode;
}

function assertStatus(error: unknown, status: number, hint: string): void {
  assert.equal(statusOf(error), status, `${hint} (${error instanceof Error ? error.message : String(error)})`);
}

interface SetupOptions {
  /** false で master key 未設定 (シークレットは使えないが変数は使える) を再現する */
  withCipher?: boolean;
}

function setup(options: SetupOptions = {}) {
  const db = AppDb.open({ storeDir: null });
  const retained: string[] = [];
  // 保存のたびに時刻が進む (世代は名前 + 更新時刻で決まるため、固定時計では変化を観測できない)
  let clock = 1_000;
  const service = new SecretService({
    store: db as SecretStore,
    cipher: options.withCipher === false ? null : createSecretCipher(parseMasterKeys(`1:${KEY}`)),
    retainSecret: (value) => retained.push(value),
    now: () => (clock += 1),
    newId: (() => {
      let count = 0;
      return () => `secret-${++count}`;
    })(),
  });
  return { db, service, retained };
}

const SCOPE: SecretScope = { cwd: "projects/alpha", projectScoped: true };
const OTHER: SecretScope = { cwd: "projects/beta", projectScoped: true };

test("名前は正規化 (trim + 大文字化) して保存し、入力の前後空白を受け付ける", () => {
  const { service, db } = setup();
  const created = service.create(SCOPE, { kind: "secret", name: "  db_url ", value: "dummy-value-1234" });
  assert.equal(created.item.name, "DB_URL");
  assert.equal(created.trimmed, false);
  assert.deepEqual(
    service.list(SCOPE).items.map((item) => item.name),
    ["DB_URL"],
  );
  db.close();
});

test("名前の規則 (文字種・長さ・予約・実行制御・公開プレフィックス) を守らせる", () => {
  const { service, db } = setup();
  const bad = (name: string, kind: "variable" | "secret" = "variable"): void => {
    assertStatus(
      (() => {
        try {
          service.create(SCOPE, { kind, name, value: "v" });
          return undefined;
        } catch (error) {
          return error;
        }
      })(),
      400,
      `name=${name}`,
    );
  };
  bad("");
  bad("1ABC");
  bad("A-B");
  bad("A B");
  bad("A.B");
  bad("あ");
  bad("A".repeat(65));
  bad("PATH");
  bad("LD_PRELOAD");
  bad("PI_ANYTHING");
  bad("PI_SANDBOX_TOKEN");
  bad("U7AGENT_SECRET_MASTER_KEY");
  // 公開プレフィックスはシークレットでは拒否し、変数では許可する
  bad("VITE_API_URL", "secret");
  bad("PUBLIC_TOKEN", "secret");
  assert.equal(
    service.create(SCOPE, { kind: "variable", name: "vite_api_url", value: "http://127.0.0.1" }).item.name,
    "VITE_API_URL",
  );
  // 64 文字はちょうど許す
  assert.equal(service.create(SCOPE, { kind: "variable", name: "A".repeat(64), value: "v" }).item.name.length, 64);
  db.close();
});

test("同名は cwd 内で 409、別の cwd なら同じ名前を登録できる", () => {
  const { service, db } = setup();
  service.create(SCOPE, { kind: "variable", name: "NODE_ENV", value: "production" });
  assert.throws(
    () => service.create(SCOPE, { kind: "secret", name: "node_env", value: "x" }),
    (error: unknown) => {
      assertStatus(error, 409, "同名の登録");
      return true;
    },
  );
  assert.equal(service.create(OTHER, { kind: "variable", name: "NODE_ENV", value: "test" }).item.name, "NODE_ENV");
  db.close();
});

test("値は前後の空白 / 改行を除去して注記を返し、CRLF は LF に寄せる", () => {
  const { service, db } = setup();
  const padded = service.create(SCOPE, { kind: "variable", name: "PADDED", value: "  line1\r\nline2\n" });
  assert.equal(padded.trimmed, true);
  assert.equal(service.detail(SCOPE, padded.item.secretId).value, "line1\nline2");
  // 加工が無ければ注記を出さない
  assert.equal(service.create(SCOPE, { kind: "variable", name: "PLAIN", value: "plain" }).trimmed, false);
  db.close();
});

test("空値・NUL・長さ超過は拒否する", () => {
  const { service, db } = setup();
  const rejects = (kind: "variable" | "secret", value: string): void => {
    assert.throws(
      () => service.create(SCOPE, { kind, name: kind === "secret" ? "S" : "V", value }),
      (error: unknown) => {
        assertStatus(error, 400, `value length=${value.length}`);
        return true;
      },
    );
  };
  rejects("variable", "   ");
  rejects("variable", "\n\n");
  rejects("variable", "has\0nul");
  rejects("variable", "x".repeat(VARIABLE_VALUE_MAX_LENGTH + 1));
  rejects("secret", "x".repeat(SECRET_VALUE_MAX_BYTES + 1));
  // シークレットはバイト数で見る (日本語 3 バイト × 3000 = 9000 バイト)
  rejects("secret", "あ".repeat(3000));
  db.close();
});

test("一覧は名前・種別・更新時刻だけで、値も桁数も返さない", () => {
  const { service, db } = setup();
  service.create(SCOPE, { kind: "secret", name: "API_KEY", value: "dummy-value-1234" });
  service.create(SCOPE, { kind: "variable", name: "NODE_ENV", value: "production" });
  const list = service.list(SCOPE);
  assert.deepEqual(
    list.items.map((item) => item.name),
    ["API_KEY", "NODE_ENV"],
    "追加は MAX(sortOrder) + 1 の昇順",
  );
  assert.equal(list.projectScoped, true);
  assert.equal(typeof list.generation, "string");
  // シークレットの詳細は値を返さず、変数の詳細だけが平文を返す
  const secret = list.items.find((item) => item.kind === "secret");
  const variable = list.items.find((item) => item.kind === "variable");
  assert.ok(secret && variable);
  assert.equal("value" in service.detail(SCOPE, secret.secretId), false, "シークレットの詳細に値がある");
  assert.equal(service.detail(SCOPE, variable.secretId).value, "production");
  db.close();
});

test("値を上書きしても名前・種別・並びは変わらず、世代が変わる", () => {
  const { service, db } = setup();
  const created = service.create(SCOPE, { kind: "secret", name: "API_KEY", value: "dummy-old-1234" });
  const before = service.list(SCOPE).generation;
  const updated = service.updateValue(SCOPE, created.item.secretId, "  dummy-new-5678  ");
  assert.equal(updated.item.name, "API_KEY");
  assert.equal(updated.item.kind, "secret");
  assert.equal(updated.trimmed, true);
  assert.notEqual(updated.generation, before, "値を変えても世代が変わらない");
  assert.deepEqual(
    service.list(SCOPE).items.map((item) => item.name),
    ["API_KEY"],
  );
  // 変数の上書きは平文が入れ替わる
  const variable = service.create(SCOPE, { kind: "variable", name: "NODE_ENV", value: "production" });
  service.updateValue(SCOPE, variable.item.secretId, "test");
  assert.equal(service.detail(SCOPE, variable.item.secretId).value, "test");
  db.close();
});

test("削除は sortOrder を詰めず、削除でも世代が変わる", () => {
  const { service, db } = setup();
  const first = service.create(SCOPE, { kind: "variable", name: "A", value: "1" });
  const second = service.create(SCOPE, { kind: "variable", name: "B", value: "2" });
  const before = service.list(SCOPE).generation;
  const removed = service.remove(SCOPE, first.item.secretId);
  assert.equal(removed.removed, true);
  assert.notEqual(removed.generation, before);
  assert.deepEqual(
    service.list(SCOPE).items.map((item) => item.name),
    ["B"],
  );
  // 追加し直しても既存行の sortOrder は変わらない (MAX + 1 が次の並びになる)
  const third = service.create(SCOPE, { kind: "variable", name: "C", value: "3" });
  assert.deepEqual(
    service.list(SCOPE).items.map((item) => item.name),
    ["B", "C"],
  );
  assert.notEqual(third.item.secretId, second.item.secretId);
  db.close();
});

test("他会話 (別の cwd) の secret_id は参照も変更も削除もできない", () => {
  const { service, db } = setup();
  const mine = service.create(SCOPE, { kind: "variable", name: "TOKEN", value: "dummy-value-1234" });
  assertStatus(
    (() => {
      try {
        service.detail(OTHER, mine.item.secretId);
      } catch (error) {
        return error;
      }
      return undefined;
    })(),
    404,
    "別 cwd の参照",
  );
  assert.throws(
    () => service.updateValue(OTHER, mine.item.secretId, "x"),
    (error: unknown) => {
      assertStatus(error, 404, "別 cwd の上書き");
      return true;
    },
  );
  assert.throws(
    () => service.remove(OTHER, mine.item.secretId),
    (error: unknown) => {
      assertStatus(error, 404, "別 cwd の削除");
      return true;
    },
  );
  // 対象の cwd にある以上、自分からは操作できる
  assert.equal(service.detail(SCOPE, mine.item.secretId).name, "TOKEN");
  db.close();
});

test("変数の値は variablesFor に入り、シークレットは入らない", () => {
  const { service, db } = setup();
  service.create(SCOPE, { kind: "variable", name: "NODE_ENV", value: "production" });
  service.create(SCOPE, { kind: "secret", name: "API_KEY", value: "dummy-value-1234" });
  service.create(OTHER, { kind: "variable", name: "OTHER_ONLY", value: "x" });
  assert.deepEqual(service.variablesFor(SCOPE.cwd), { NODE_ENV: "production" });
  assert.deepEqual(service.variablesFor("projects/empty"), {});
  db.close();
});

test("serve の起動 env は変数と復号したシークレットの両方で、復号値はマスカーへ登録する", () => {
  const { service, db, retained } = setup();
  service.create(SCOPE, { kind: "variable", name: "NODE_ENV", value: "production" });
  service.create(SCOPE, { kind: "secret", name: "DATABASE_URL", value: "dummy-db-url-1234" });
  // 8 文字未満は登録しない (会話本文の過剰な置換を避ける)
  service.create(SCOPE, { kind: "secret", name: "SHORT", value: "abc123" });
  // 保存時にも登録済みなので、復号時 (起動時) の登録だけを見る
  retained.length = 0;
  const env = service.resolveServiceEnv(SCOPE.cwd);
  assert.deepEqual(env.variables, { NODE_ENV: "production" });
  assert.deepEqual(env.secrets, { DATABASE_URL: "dummy-db-url-1234", SHORT: "abc123" });
  assert.equal(env.generation, service.list(SCOPE).generation);
  assert.deepEqual(retained, ["dummy-db-url-1234"], "8 文字未満も登録されてはならない");
  db.close();
});

test("master key が無い / 保存値が壊れているときはシークレットの利用を拒否する (平文へ落とさない)", () => {
  const withoutKey = setup({ withCipher: false });
  withoutKey.service.create(SCOPE, { kind: "variable", name: "NODE_ENV", value: "production" });
  assert.deepEqual(withoutKey.service.variablesFor(SCOPE.cwd), { NODE_ENV: "production" }, "変数は鍵が無くても使える");
  assert.throws(
    () => withoutKey.service.create(SCOPE, { kind: "secret", name: "API_KEY", value: "dummy-value-1234" }),
    (error: unknown) => {
      assertStatus(error, 503, "鍵なしのシークレット登録");
      return true;
    },
  );
  // 平文で保存されていないこと (シークレットの行が作られない)
  assert.deepEqual(
    withoutKey.service.list(SCOPE).items.filter((item) => item.kind === "secret"),
    [],
  );
  withoutKey.db.close();

  const { service, db } = setup();
  const created = service.create(SCOPE, { kind: "secret", name: "API_KEY", value: "dummy-value-1234" });
  // 保存行を壊して復号失敗を作る (改ざんと同じ経路)
  const row = db.getSecret(created.item.secretId);
  assert.ok(row?.ciphertext);
  db.updateSecretValue(created.item.secretId, {
    plaintext: null,
    ciphertext: new Uint8Array([0, 1, 2, 3]),
    nonce: row.nonce,
    keyVersion: row.keyVersion,
    updatedAt: 2_000,
  });
  assert.throws(
    () => service.resolveServiceEnv(SCOPE.cwd),
    (error: unknown) => {
      assertStatus(error, 503, "壊れた保存値での起動 env");
      return true;
    },
  );
  db.close();
});

test("世代は値ではなく名前と更新時刻で決まる (空の cwd は空文字)", () => {
  const { service, db } = setup();
  assert.equal(service.list(SCOPE).generation, "");
  const created = service.create(SCOPE, { kind: "variable", name: "NODE_ENV", value: "production" });
  const one = secretGeneration(db.listSecrets(SCOPE.cwd));
  assert.equal(one, created.generation);
  service.updateValue(SCOPE, created.item.secretId, "test");
  assert.notEqual(secretGeneration(db.listSecrets(SCOPE.cwd)), one);
  db.close();
});

test("要求元は会話かプロジェクトのどちらか一方で、cwd への解決はサーバーだけが行う", () => {
  const scope = createSecretScope({
    sessions: { workdirOfId: (id) => (id === "known" ? "projects/alpha" : undefined) },
    projects: {
      get: (id) => (id === "p1" ? { cwd: "projects/alpha" } : undefined),
      findByCwd: (cwd) => (cwd === "projects/alpha" ? { id: "p1" } : undefined),
    },
  });
  assert.deepEqual(scope.resolve({ sessionId: "known" }), { cwd: "projects/alpha", projectScoped: true });
  assert.deepEqual(scope.resolve({ projectId: "p1" }), { cwd: "projects/alpha", projectScoped: true });
  // 未所属の会話は cwd がスクラッチで、プロジェクト所属ではない
  const scratch = createSecretScope({
    sessions: { workdirOfId: () => ".u7agent/sessions/s1" },
    projects: { get: () => undefined, findByCwd: () => undefined },
  });
  assert.deepEqual(scratch.resolve({ sessionId: "s1" }), { cwd: ".u7agent/sessions/s1", projectScoped: false });
  const rejected: { input: { sessionId?: string; projectId?: string }; status: number }[] = [
    { input: { sessionId: "known", projectId: "p1" }, status: 400 },
    { input: { sessionId: "missing" }, status: 404 },
    { input: { projectId: "missing" }, status: 404 },
  ];
  for (const { input, status } of rejected) {
    assert.throws(
      () => scope.resolve(input),
      (error: unknown) => {
        assertStatus(error, status, JSON.stringify(input));
        return true;
      },
    );
  }
  // どちらも無い指定は 400 (曖昧なまま操作させない)
  assert.throws(
    () => scope.resolve({}),
    (error: unknown) => {
      assertStatus(error, 400, "指定なし");
      return true;
    },
  );
});
