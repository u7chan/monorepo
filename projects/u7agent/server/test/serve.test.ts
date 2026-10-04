// serve (サービス) の状態・起動・停止の分岐。サンドボックスはスクリプトを解釈するスタブへ差し替える。
//   - 稼働判定は常にプローブで、記録は表示と操作権限にだけ使う
//   - 所有者の照合 (pid + 起動時刻)、所有者以外の停止拒否、起動元不明の停止許可
//   - 置き換えの世代照合 (409)、同時要求の直列化、期限つきの到達確認
//   - プローブ / サンドボックスの失敗は停止中へ丸めない (502 / 503)
import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";
import { ServeService, sandboxHostFromUrl, tcpHost } from "../src/serve";
import {
  createCommandStore,
  createProbe,
  createServeSandboxStub,
  createSessionLookup,
  putRecord,
  readRecord,
} from "./serve-stub";

const SESSION = "aaaa000001";
const OTHER = "bbbb000002";
const CWD = "projects/foo";
const NOW = 1_700_000_000_000;

/** 画面と同じく、状態 API が返した照合値をそのまま返す */
async function token(service: ServeService, sessionId: string): Promise<string | null> {
  return (await service.status(sessionId)).generation;
}

/** 検証の共通組み立て。sessions は閲覧中の会話 + 他会話 (所有者) の 2 件 */
function setup(
  options: {
    reachable?: boolean;
    command?: string;
    owner?: string | null;
    /** 到達可のまま待受 PID を特定できない状態を作る (観測スクリプトが何も返さない) */
    listenerUnknown?: boolean;
  } = {},
) {
  const sandbox = createServeSandboxStub();
  const commands = createCommandStore(options.command ? [{ cwd: CWD, command: options.command, updatedAt: NOW }] : []);
  const sessions = createSessionLookup({
    [SESSION]: { cwd: CWD, title: "トップページの改修" },
    [OTHER]: { cwd: "projects/bar", title: "決済画面の検証" },
  });
  // 稼働判定は待受プロセスの有無で決まる (launch すると listen が始まり、kill で消える)
  let probeCalls = 0;
  const probe = async (): Promise<boolean> => {
    probeCalls += 1;
    if (options.listenerUnknown) return true;
    return sandbox.state.listener !== null;
  };
  // 期限つきの待ちが終わるよう、sleep で時計を進める (実時間は使わない)
  const clock = { value: NOW };
  const service = new ServeService({
    appDb: commands.db,
    sessions,
    sandbox: sandbox.sandbox,
    probe: probe,
    now: () => clock.value,
    sleep: async (ms: number) => {
      clock.value += ms;
    },
  });
  if (options.owner) {
    putRecord(sandbox.state, {
      sessionId: options.owner,
      cwd: options.owner === OTHER ? "projects/bar" : CWD,
      command: "pnpm dev",
      pid: 100,
      startedAt: NOW - 5_000,
      inodes: [500],
      generation: "gen-1",
    });
    sandbox.state.listener = { pid: 100, startedAt: NOW - 5_000, inodes: [500], ancestors: [100] };
  }
  // 到達不可だが記録だけ残っている状態 (コンテナ再作成相当)
  if (options.reachable === false && options.owner) sandbox.state.listener = null;
  return { service, sandbox, commands, probe: { calls: () => probeCalls }, clock };
}

test("サンドボックス URL の 3 形態から TCP 接続用の host を取り出す (IPv6 は角括弧を外す)", () => {
  // URL.hostname は IPv6 リテラルを角括弧付きで返すが、net.connect はそれを名前解決しようとする
  assert.equal(sandboxHostFromUrl("http://[::1]:9418"), "::1");
  assert.equal(sandboxHostFromUrl("http://127.0.0.1:9418"), "127.0.0.1");
  assert.equal(sandboxHostFromUrl("http://u7agent-sandbox:9418"), "u7agent-sandbox");
  // 前後の空白と未設定・不正値は既定へ倒す
  assert.equal(sandboxHostFromUrl("  http://[::1]:9418  "), "::1");
  for (const value of [undefined, "", "   ", "not a url"]) {
    assert.equal(sandboxHostFromUrl(value), undefined);
  }
  assert.equal(tcpHost("[::1]"), "::1");
  assert.equal(tcpHost("::1"), "::1");
  assert.equal(tcpHost("u7agent-sandbox"), "u7agent-sandbox");
});

test("IPv6 リテラルのサンドボックス URL でも到達確認が 502 にならない", async () => {
  // ::1 で待受するサーバーを立て、そのポートを serve listen ポートとして渡す
  const server = createServer((_socket) => {});
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "::1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const sandbox = createServeSandboxStub();
  const service = new ServeService({
    appDb: createCommandStore().db,
    sessions: createSessionLookup({ [SESSION]: { cwd: CWD, title: "トップページの改修" } }),
    sandbox: sandbox.sandbox,
    // `PI_SANDBOX_URL=http://[::1]:<port>` と同じ解決を通す
    sandboxHost: sandboxHostFromUrl(`http://[::1]:${port}`),
    listenPort: port,
    now: () => NOW,
  });
  try {
    // 角括弧が残っていると getaddrinfo ENOTFOUND で 502 になる
    const status = await service.status(SESSION);
    assert.equal(status.reachable, true, "IPv6 の待受先へ接続できていない");
  } finally {
    server.close();
  }
});

test("ランタイムは現在の記録のコマンドと会話を返し、古い実績は使わない", async () => {
  const { service, sandbox, commands } = setup({ owner: OTHER });
  commands.rows.set("projects/bar", { cwd: "projects/bar", command: "outdated", updatedAt: NOW });
  const status = await service.runtimeStatus();
  assert.equal(status.reachable, true);
  assert.deepEqual(status.owner, { sessionId: OTHER, title: "決済画面の検証" });
  assert.deepEqual(status.command, { cwd: "projects/bar", command: "pnpm dev" });
  assert.equal(sandbox.state.scans, 0, "状態表示では fd 走査しない");
  await service.runtimeStop({ generation: status.generation! });
  assert.deepEqual(sandbox.state.killed, [100]);
  assert.deepEqual(await service.runtimeStatus(), { reachable: false, owner: null, generation: null, command: null });
});

test("ランタイムは一致しない記録の会話・コマンドを見せず、確認後の入れ替わりを停止しない", async () => {
  const { service, sandbox } = setup({ owner: OTHER });
  const previous = await service.runtimeStatus();
  sandbox.state.listener = { pid: 999, startedAt: NOW, inodes: [999], ancestors: [999] };
  await assert.rejects(service.runtimeStop({ generation: previous.generation! }), { statusCode: 409 });
  assert.deepEqual(sandbox.state.killed, []);
  const unknown = await service.runtimeStatus();
  assert.equal(unknown.reachable, true);
  assert.equal(unknown.owner, null);
  assert.equal(unknown.command, null);
  await service.runtimeStop({ generation: unknown.generation! });
  assert.deepEqual(sandbox.state.killed, [999]);
});

test("削除済み会話のリンクやコンテナ再作成後の古い記録はランタイムへ出さない", async () => {
  const deleted = setup({ owner: "deleted000" });
  assert.equal((await deleted.service.runtimeStatus()).owner, null);
  const restarted = setup({ owner: OTHER, reachable: false });
  assert.deepEqual(await restarted.service.runtimeStatus(), {
    reachable: false,
    owner: null,
    generation: null,
    command: null,
  });
});

test("全体停止でも待受PID不明と停止未完了を成功にしない", async () => {
  const unknown = setup({ listenerUnknown: true });
  const status = await unknown.service.runtimeStatus();
  await assert.rejects(unknown.service.runtimeStop({ generation: status.generation! }), { statusCode: 409 });
  const failed = setup({ owner: OTHER });
  failed.sandbox.state.killWorks = false;
  const before = await failed.service.runtimeStatus();
  await assert.rejects(failed.service.runtimeStop({ generation: before.generation! }), { statusCode: 502 });
  assert.equal((await failed.service.runtimeStatus()).reachable, true);
});

test("到達不可なら実績だけで停止中になり、記録は見せない", async () => {
  const { service, sandbox } = setup({ command: "pnpm dev", owner: OTHER, reachable: false });
  // 記録は残っていても、プローブが到達不可なら稼働中とは言わない
  const status = await service.status(SESSION);
  assert.deepEqual(status, {
    reachable: false,
    owner: { kind: "none" },
    generation: null,
    command: { cwd: CWD, command: "pnpm dev" },
    secretGeneration: null,
  });
  // 到達不可のときはサンドボックスの観測を走らせない (記録も待受 PID も表示に使わない)
  assert.equal(sandbox.cwds.length, 0);
});

test("実績が無ければ command は null で、別の作業ディレクトリの実績は返さない", async () => {
  const { service, commands } = setup({ command: "pnpm dev" });
  commands.rows.set("projects/bar", { cwd: "projects/bar", command: "pnpm start", updatedAt: NOW });
  const status = await service.status(SESSION);
  assert.equal(status.command?.command, "pnpm dev");
  const other = await service.status(OTHER);
  assert.equal(other.command?.command, "pnpm start");
});

test("記録と待受プロセスが一致すれば所有者を mine / other に分ける", async () => {
  const mine = setup({ reachable: true, owner: SESSION });
  assert.deepEqual((await mine.service.status(SESSION)).owner, { kind: "mine", title: "トップページの改修" });

  const other = setup({ reachable: true, owner: OTHER });
  assert.deepEqual((await other.service.status(SESSION)).owner, { kind: "other", title: "決済画面の検証" });
  // 所有者の会話から見れば mine (同じ記録でも見る会話で変わる)
  assert.deepEqual((await other.service.status(OTHER)).owner, { kind: "mine", title: "決済画面の検証" });
});

test("待受ソケットが記録と一致しなければ起動元不明にする", async () => {
  // 生の bash が別のソケットで listen し直した状態 (inode が変わる)
  const replaced = setup({ reachable: true, owner: OTHER });
  replaced.sandbox.state.listener = { pid: 999, startedAt: NOW - 5_000, inodes: [999], ancestors: [999] };
  assert.deepEqual((await replaced.service.status(SESSION)).owner, { kind: "unknown" });

  // inode を持たない記録 (この項目より前の版が書いたもの) は一致とみなさない
  const legacy = setup({ reachable: true, owner: OTHER });
  legacy.sandbox.state.stateFile = JSON.stringify({
    sessionId: OTHER,
    cwd: "projects/bar",
    command: "pnpm dev",
    pid: 100,
    startedAt: NOW - 5_000,
    generation: "gen-1",
  });
  assert.deepEqual((await legacy.service.status(SESSION)).owner, { kind: "unknown" });

  // 記録が壊れていても所有者とみなさない
  const broken = setup({ reachable: true });
  broken.sandbox.state.stateFile = "{ not json";
  broken.sandbox.state.listener = { pid: 100, startedAt: NOW, inodes: [500], ancestors: [100] };
  const status = await broken.service.status(SESSION);
  assert.deepEqual(status.owner, { kind: "unknown" });
  // 到達可なら置き換えの照合値は必ず載る (記録が無くても「いまの待受ソケット」を表す)
  assert.equal(typeof status.generation, "string");
});

test("所有者の会話が消えていれば他会話ではなく起動元不明として扱う", async () => {
  const { service, sandbox } = setup({ reachable: true, owner: "cccc000003" });
  assert.deepEqual((await service.status(SESSION)).owner, { kind: "unknown" });
  // 会話ストアの一覧に無い id は「他会話」と呼ばない (削除済みの記録)
  assert.equal(readRecord(sandbox.state)?.sessionId, "cccc000003");
});

test("未知の会話は 404 にする", async () => {
  const { service } = setup();
  await assert.rejects(
    () => service.status("unknown000"),
    (error: unknown) => (error as { statusCode?: number }).statusCode === 404,
  );
});

test("停止は所有者以外を 403 で拒み、所有者と起動元不明は許可する", async () => {
  const owned = setup({ reachable: true, owner: OTHER });
  const ownedToken = await token(owned.service, SESSION);
  await assert.rejects(
    () => owned.service.stop(SESSION, { generation: ownedToken }),
    (error: unknown) => (error as { statusCode?: number }).statusCode === 403,
  );
  assert.deepEqual(owned.sandbox.state.killed, [], "拒否したときは kill しない");

  const mine = setup({ reachable: true, owner: SESSION });
  const stopped = await mine.service.stop(SESSION, { generation: await token(mine.service, SESSION) });
  assert.equal(stopped.reachable, false);
  assert.deepEqual(mine.sandbox.state.killed, [100], "記録の PID ではなく待受 PID を止める");
  assert.equal(mine.sandbox.state.stateFile, null, "停止後は記録を残さない");

  // 起動元不明 (記録と一致しないソケット) は誰でも止められる
  const unknown = setup({ reachable: true, owner: OTHER });
  unknown.sandbox.state.listener = { pid: 777, startedAt: NOW, inodes: [777], ancestors: [777] };
  await unknown.service.stop(SESSION, { generation: await token(unknown.service, SESSION) });
  assert.deepEqual(unknown.sandbox.state.killed, [777]);
});

test("待受 PID を特定できないときは停止せず、エージェントへ依頼する理由を返す", async () => {
  const { service, sandbox } = setup({ listenerUnknown: true });
  const listenerToken = await token(service, SESSION);
  await assert.rejects(
    () => service.stop(SESSION, { generation: listenerToken }),
    (error: unknown) => {
      assert.equal((error as { statusCode?: number }).statusCode, 409);
      assert.match((error as Error).message, /待受プロセスを特定できません/);
      assert.match((error as Error).message, /エージェント/);
      return true;
    },
  );
  assert.deepEqual(sandbox.state.killed, []);
});

test("停止後の解放を確認できないときは 502 にする", async () => {
  const { service, sandbox } = setup({ reachable: true, owner: SESSION });
  // kill してもポートが空かない (解放の確認に失敗する) 状態を作る
  sandbox.state.killWorks = false;
  const releaseToken = await token(service, SESSION);
  await assert.rejects(
    () => service.stop(SESSION, { generation: releaseToken }),
    (error: unknown) => {
      assert.equal((error as { statusCode?: number }).statusCode, 502);
      assert.match((error as Error).message, /解放されていません/);
      return true;
    },
  );
});

test("待受プロセスが入れ替われば、記録が同じでも照合値が変わる (生の bash の置き換えを検知)", async () => {
  const { service, sandbox, clock } = setup({ reachable: true, owner: SESSION });
  const before = await token(service, SESSION);
  // 記録はそのままに、生の bash が新しいソケットへ入れ替える
  sandbox.state.listener = { pid: 555, startedAt: NOW + 1_000, inodes: [555], ancestors: [555] };
  clock.value += 5_000;
  assert.notEqual(await token(service, SESSION), before);
  // 古い確認のままの停止は、記録の世代が同じでも 409 になる
  await assert.rejects(
    () => service.stop(SESSION, { generation: before }),
    (error: unknown) => (error as { statusCode?: number }).statusCode === 409,
  );
  assert.deepEqual(sandbox.state.killed, [], "古い確認では新しいプロセスを止めない");
});

test("到達不可のあとに記録なしのプロセスが起動しても、確認なしの置き換えは通らない", async () => {
  const { service, sandbox } = setup({ command: "pnpm dev" });
  // 停止中の状態 (照合値 null) を確認したあとで、生の bash が記録なしで listen する
  const stopped = await token(service, SESSION);
  assert.equal(stopped, null);
  sandbox.state.listener = { pid: 888, startedAt: NOW, inodes: [888], ancestors: [888] };
  await assert.rejects(
    () => service.start(SESSION, { generation: stopped }),
    (error: unknown) => (error as { statusCode?: number }).statusCode === 409,
  );
  assert.deepEqual(sandbox.state.killed, []);
  assert.deepEqual(sandbox.state.launched, []);
});

test("到達不可の停止は何も止めずに停止済みとして返す (冪等)", async () => {
  const { service, sandbox } = setup({ command: "pnpm dev", owner: OTHER });
  sandbox.state.listener = null;
  const status = await service.stop(SESSION, { generation: null });
  assert.equal(status.reachable, false);
  assert.deepEqual(sandbox.state.killed, []);
  // 到達不可のときはサンドボックスへ触らない (記録の後始末も含めて何もしない)
  assert.deepEqual(sandbox.cwds, []);
});

test("起動は実績のコマンドを作業ディレクトリで実行し、成功時だけ実績を更新する", async () => {
  const { service, sandbox, commands } = setup({ command: "pnpm dev" });
  const status = await service.start(SESSION, {});
  assert.equal(status.reachable, true);
  assert.deepEqual(sandbox.state.launched, [{ workdir: CWD, command: "pnpm dev", log: ".u7agent/serve/app.log" }]);
  // 起動 → 到達可 → 待受 PID を正として記録し直す (2 回書く)
  assert.equal(sandbox.state.writes, 2);
  const record = readRecord(sandbox.state);
  assert.equal(record?.sessionId, SESSION);
  assert.equal(record?.cwd, CWD);
  assert.equal(record?.command, "pnpm dev");
  assert.equal(record?.pid, 4242, "待受 PID で上書きする");
  assert.equal(typeof record?.generation, "string");
  assert.equal(commands.rows.get(CWD)?.command, "pnpm dev");
  assert.deepEqual((await service.status(SESSION)).owner, { kind: "mine", title: "トップページの改修" });
});

test("起動の失敗は実績を上書きせず、試みた事実だけを残す", async () => {
  const { service, sandbox, commands } = setup({ command: "pnpm dev" });
  sandbox.state.launchListens = false;
  await assert.rejects(
    () => service.start(SESSION, { command: "pnpm start" }),
    (error: unknown) => {
      assert.equal((error as { statusCode?: number }).statusCode, 502);
      assert.match((error as Error).message, /到達できませんでした/);
      return true;
    },
  );
  // 仮の記録 (起動 PID) は残るが、以前の成功コマンドは上書きしない
  assert.equal(readRecord(sandbox.state)?.pid, 4242);
  assert.equal(commands.rows.get(CWD)?.command, "pnpm dev");
  assert.equal(sandbox.state.writes, 1);
});

test("到達した待受プロセスが起動 PID の子孫なら成功とし、待受 PID を記録する", async () => {
  const { service, sandbox, commands } = setup({ command: "pnpm dev" });
  // `pnpm dev` のように起動 PID の子孫が待ち受ける形 (listener 行の後に ancestors 行が続く)
  sandbox.state.listenerOnLaunch = { pid: 5000, startedAt: NOW + 200, inodes: [5000], ancestors: [5000, 4242] };
  const status = await service.start(SESSION, {});
  assert.equal(status.reachable, true);
  assert.deepEqual(status.owner, { kind: "mine", title: "トップページの改修" });
  // 待受 PID と待受ソケットの inode を正として記録する (起動を試みた PID ではない)
  assert.equal(readRecord(sandbox.state)?.pid, 5000);
  assert.deepEqual(readRecord(sandbox.state)?.inodes, [5000]);
  // 成功実績も保存される
  assert.equal(commands.rows.get(CWD)?.command, "pnpm dev");
});

test("到達してもこの起動に由来しないプロセスなら成功としない (遅れて listen した別の起動を拾わない)", async () => {
  const { service, sandbox, commands } = setup({ command: "pnpm dev" });
  // 期限超過した別の起動が、今回の起動の直後に遅れて listen した状態を作る
  sandbox.state.listenerOnLaunch = { pid: 777, startedAt: NOW + 500, inodes: [777], ancestors: [777, 666] };
  await assert.rejects(
    () => service.start(SESSION, { command: "pnpm start" }),
    (error: unknown) => {
      assert.equal((error as { statusCode?: number }).statusCode, 502);
      assert.match((error as Error).message, /この起動に由来しない/);
      return true;
    },
  );
  // 別の起動の PID を自分のものとして記録せず、実績も上書きしない
  assert.equal(readRecord(sandbox.state)?.pid, 4242);
  assert.equal(commands.rows.get(CWD)?.command, "pnpm dev");
  assert.equal(sandbox.state.writes, 1);
});

test("実績が無ければ起動せず 400 にする (公開中のサービスを先に止めない)", async () => {
  const { service, sandbox } = setup();
  await assert.rejects(
    () => service.start(SESSION, {}),
    (error: unknown) => (error as { statusCode?: number }).statusCode === 400,
  );
  assert.deepEqual(sandbox.state.launched, []);

  // 他会話が公開中でも、実績の無い会話の起動は停止の前に 400 で止まる (何も壊さない)
  const published = setup({ reachable: true, owner: OTHER });
  const publishedToken = await token(published.service, SESSION);
  await assert.rejects(
    () => published.service.start(SESSION, { generation: publishedToken }),
    (error: unknown) => (error as { statusCode?: number }).statusCode === 400,
  );
  assert.deepEqual(published.sandbox.state.killed, [], "コマンドが無いのに既存を止めない");
  assert.deepEqual(published.sandbox.state.launched, []);
});

test("起動コマンドと作業ディレクトリは shell の構文として評価されない (文字列データとして渡す)", async () => {
  // `$` やバッククォートを含む作業ディレクトリは登録できる (normalizeProjectCwd は禁止しない)
  const sandbox = createServeSandboxStub();
  const commands = createCommandStore([{ cwd: "projects/cash$flow", command: 'echo "$(id)" `id`', updatedAt: NOW }]);
  const service = new ServeService({
    appDb: commands.db,
    sessions: createSessionLookup({ [SESSION]: { cwd: "projects/cash$flow", title: "t" } }),
    sandbox: sandbox.sandbox,
    probe: async () => sandbox.state.listener !== null,
    now: () => NOW,
    sleep: async () => {},
  });
  await service.start(SESSION, {});
  // スクリプトは値を base64 で運び、stub はそれを復号して受け取る (shell が評価する形で埋め込まない)
  assert.deepEqual(sandbox.state.launched, [
    { workdir: "projects/cash$flow", command: 'echo "$(id)" `id`', log: ".u7agent/serve/app.log" },
  ]);
});

test("到達可のときの起動は待受プロセスを置き換え、世代が違えば 409 で止める", async () => {
  const replaced = setup({ reachable: true, owner: OTHER, command: "pnpm dev" });
  await replaced.service.start(SESSION, { generation: await token(replaced.service, SESSION) });
  assert.deepEqual(replaced.sandbox.state.killed, [100], "所有者のプロセスを停止してから置き換える");
  assert.deepEqual(
    replaced.sandbox.state.launched.map((item) => item.workdir),
    [CWD],
  );

  const conflict = setup({ reachable: true, owner: OTHER, command: "pnpm dev" });
  await assert.rejects(
    () => conflict.service.start(SESSION, { generation: "old-generation" }),
    (error: unknown) => {
      assert.equal((error as { statusCode?: number }).statusCode, 409);
      assert.match((error as Error).message, /確認し直してください/);
      return true;
    },
  );
  assert.deepEqual(conflict.sandbox.state.killed, [], "照合不一致では何も止めない");
  assert.deepEqual(conflict.sandbox.state.launched, []);

  // 到達不可なら世代は null のまま一致し、置き換えの停止は起こらない
  const stopped = setup({ command: "pnpm dev" });
  await stopped.service.start(SESSION, { generation: null });
  assert.deepEqual(stopped.sandbox.state.killed, []);
});

test("同時の起動要求は直列化し、古い確認のままの要求は 409 で止める", async () => {
  const { service, sandbox } = setup({ command: "pnpm dev" });
  // 到達確認の途中で別の要求が入っても、ロックの内側で判定し直す (二重起動を作らない)。
  // 2 本目は 1 本目が立てた世代と合わないため、UI に確認をやり直させる
  const results = await Promise.allSettled([service.start(SESSION, {}), service.start(SESSION, {})]);
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[1].status, "rejected");
  assert.equal(
    (results[1] as PromiseRejectedResult).reason.statusCode,
    409,
    "古い状態で確認した要求は置き換えを実行しない",
  );
  assert.equal(sandbox.state.launched.length, 1, "二重起動しない");

  // 世代を揃えた要求は直列に置き換える (所有者のプロセスを止めてから起動する)
  const replace = setup({ reachable: true, owner: OTHER, command: "pnpm dev" });
  const replaceToken = await token(replace.service, SESSION);
  const settled = await Promise.allSettled([
    replace.service.start(SESSION, { generation: replaceToken }),
    replace.service.start(SESSION, { generation: replaceToken }),
  ]);
  assert.equal(settled[0].status, "fulfilled");
  assert.equal(settled[1].status, "rejected");
  assert.equal(replace.sandbox.state.launched.length, 1);
  assert.deepEqual(replace.sandbox.state.killed, [100]);
});

test("状態の取得は fd 走査をせず、停止と起動の判定でだけ待受 PID を特定する", async () => {
  const { service, sandbox } = setup({ reachable: true, owner: SESSION });
  const status = await service.status(SESSION);
  assert.deepEqual(status.owner, { kind: "mine", title: "トップページの改修" });
  assert.equal(sandbox.state.scans, 0, "状態表示では /proc の fd 走査をしない");

  // 停止は待受 PID が要るので走査する (必要なときだけ)
  await service.stop(SESSION, { generation: status.generation });
  assert.equal(sandbox.state.scans, 1);
});

test("状態の判定は短くキャッシュし、起動・停止の直後に捨てる", async () => {
  const sandbox = createServeSandboxStub();
  const probe = createProbe(false);
  const now = { value: NOW };
  const cached = new ServeService({
    appDb: createCommandStore([{ cwd: CWD, command: "pnpm dev", updatedAt: NOW }]).db,
    sessions: createSessionLookup({ [SESSION]: { cwd: CWD, title: "トップページの改修" } }),
    sandbox: sandbox.sandbox,
    probe: probe.probe,
    now: () => now.value,
    sleep: async () => {},
  });
  await cached.status(SESSION);
  await cached.status(SESSION);
  assert.equal(probe.calls(), 1, "期限内は同じ判定を使い回す");
  now.value = NOW + 5_000;
  await cached.status(SESSION);
  assert.equal(probe.calls(), 2);
});

test("プローブの失敗は 502 にし、到達不可へ丸めない", async () => {
  const sandbox = createServeSandboxStub();
  const commands = createCommandStore();
  const service = new ServeService({
    appDb: commands.db,
    sessions: createSessionLookup({ [SESSION]: { cwd: CWD, title: "t" } }),
    sandbox: sandbox.sandbox,
    probe: async () => {
      const error = new Error("サンドボックス (sandbox:8080) へ接続できません: getaddrinfo ENOTFOUND") as Error & {
        statusCode?: number;
      };
      error.statusCode = 502;
      throw error;
    },
    now: () => NOW,
  });
  await assert.rejects(
    () => service.status(SESSION),
    (error: unknown) => (error as { statusCode?: number }).statusCode === 502,
  );
});

test("サンドボックス未設定とサンドボックス障害は 503 / 502 にする", async () => {
  // プローブが false でも「未設定」は状態を返さず 503 (停止中として 200 を返さない)
  for (const reachable of [true, false]) {
    const unconfigured = new ServeService({
      appDb: createCommandStore([{ cwd: CWD, command: "pnpm dev", updatedAt: NOW }]).db,
      sessions: createSessionLookup({ [SESSION]: { cwd: CWD, title: "t" } }),
      sandbox: null,
      probe: async () => reachable,
      now: () => NOW,
    });
    assert.equal(unconfigured.configured, false);
    await assert.rejects(
      () => unconfigured.status(SESSION),
      (error: unknown) => (error as { statusCode?: number }).statusCode === 503,
      `reachable=${reachable}`,
    );
  }

  const failing = setup({ reachable: true, owner: SESSION });
  failing.sandbox.state.fail = true;
  await assert.rejects(
    () => failing.service.status(SESSION),
    (error: unknown) => {
      assert.equal((error as { statusCode?: number }).statusCode, 502);
      assert.match((error as Error).message, /serve 操作に失敗しました/);
      return true;
    },
  );
});

test("app-db の失敗はそのまま伝える (空の実績へ黙って落とさない)", async () => {
  const { service, commands } = setup({ reachable: true, owner: SESSION });
  commands.state.fail = true;
  await assert.rejects(() => service.status(SESSION));
});

test("起動時の環境変数はコマンド文字列へ埋め込まず、exec の env として渡す", async () => {
  const sandbox = createServeSandboxStub();
  const scripts: string[] = [];
  const service = new ServeService({
    appDb: createCommandStore([{ cwd: CWD, command: "pnpm dev", updatedAt: NOW }]).db,
    sessions: createSessionLookup({ [SESSION]: { cwd: CWD, title: "トップページの改修" } }),
    // 観測スクリプトも含めて、サンドボックスへ送ったスクリプト本文を控える
    sandbox: {
      execute: async (tool, input) => {
        scripts.push(((input.params ?? {}) as { command?: string }).command ?? "");
        return sandbox.sandbox.execute(tool, input);
      },
    },
    secretEnv: {
      resolveServiceEnv: (cwd) => ({
        variables: { NODE_ENV: "production" },
        secrets: { DATABASE_URL: "dummy-db-url-1234" },
        generation: `gen:${cwd}`,
      }),
    },
    probe: async () => sandbox.state.listener !== null,
    now: () => NOW,
  });
  const status = await service.start(SESSION, {});
  assert.deepEqual(sandbox.state.launchEnvs.at(-1), {
    NODE_ENV: "production",
    DATABASE_URL: "dummy-db-url-1234",
  });
  // 値は起動スクリプト (tool args) へ入らない (base64 化もしない)
  const launchScript = scripts.find((script) => script.includes("nohup bash -c")) ?? "";
  assert.ok(launchScript.includes("serve:ok"), "起動スクリプトが送られていない");
  assert.equal(launchScript.includes("dummy-db-url-1234"), false, "シークレットがスクリプトへ埋め込まれている");
  assert.equal(Buffer.from(launchScript, "utf8").includes(Buffer.from("dummy-db-url-1234")), false);
  // 世代は起動時に解決した値のもの。記録にも値そのものは載らない
  assert.equal(status.secretGeneration, `gen:${CWD}`);
  const record = readRecord(sandbox.state);
  assert.equal(record?.secretGeneration, `gen:${CWD}`);
  assert.equal(JSON.stringify(record).includes("dummy-db-url-1234"), false, "記録に値が載っている");
  // 停止すると記録ごと消えるため、起動時に解決した世代は残らない (値も残らない)
  const stopped = await service.stop(SESSION, { generation: status.generation });
  assert.equal(stopped.secretGeneration, null);
});

test("環境変数の解決に失敗したら起動しない (秘密なし起動へ黙って落とさない)", async () => {
  const sandbox = createServeSandboxStub();
  const failure = Object.assign(new Error("シークレットの master key が未設定です"), { statusCode: 503 });
  const service = new ServeService({
    appDb: createCommandStore([{ cwd: CWD, command: "pnpm dev", updatedAt: NOW }]).db,
    sessions: createSessionLookup({ [SESSION]: { cwd: CWD, title: "トップページの改修" } }),
    sandbox: sandbox.sandbox,
    secretEnv: {
      resolveServiceEnv: () => {
        throw failure;
      },
    },
    probe: async () => sandbox.state.listener !== null,
    now: () => NOW,
  });
  await assert.rejects(() => service.start(SESSION, {}), failure);
  assert.deepEqual(sandbox.state.launched, [], "環境変数が解決できていないのに起動している");
});
