/**
 * 追加スペースの削除。会話 → 作業フォルダ (サンドボックス) → DB の順に進め、`spaces` 行の削除を
 * commit point にする (途中で失敗しても行が残るので再試行できる)。契約は docs/api.md のスペースの節、
 * 消える範囲は docs/persistence.md のスペースの節を正とする。
 */
import { spaceDirRel } from "./app-paths";
import type { AppDb } from "./app-db";
import { httpError, messageFor, sandboxFailureStatus, SANDBOX_NOT_CONFIGURED_MESSAGE } from "./http";
import { SandboxRequestError } from "./sandbox/client";
import type { SandboxWorkspaceClient } from "./sandbox/client";
import type { ServeService } from "./serve";
import type { SessionStore } from "./sessions";
import type { SpaceStore } from "./spaces";

export interface SpaceDeleteDeps {
  spaces: SpaceStore;
  store: SessionStore;
  workspace: SandboxWorkspaceClient | null;
  serve: ServeService;
  appDb: AppDb;
}

export function createSpaceDelete({ spaces, store, workspace, serve, appDb }: SpaceDeleteDeps) {
  return {
    /**
     * 追加スペースを会話・履歴・作業フォルダ・cwd キーの行ごと消す。要求の id の検証 (400 / 404 / 409)
     * は冒頭の claim が行い、成功・失敗によらず解放する。
     */
    async remove(spaceId: string): Promise<void> {
      const id = spaces.claim(spaceId);
      try {
        if (!workspace) throw httpError(503, SANDBOX_NOT_CONFIGURED_MESSAGE);
        await assertNoPublicService(serve, id);
        assertStoreReady(store);
        // 対象スペースへ向かう受理済みの引っ越しは claim では止まらない。作業フォルダを運んだまま
        // 根を消すと移動元の会話のファイルも失うため、完了 / ロールバックまで待ってから消し始める
        await store.waitForMovesInto(id);
        await removeSessions(store, serve, id);
        // 再走査。最初の走査の後に完了した引っ越し / 会話作成を取りこぼさない
        await removeSessions(store, serve, id);
        await removeSpaceRoot(workspace, id);
        appDb.deleteSpace(id);
        // コミット後の回収。回収した会話の作業フォルダは根の削除後に作られている
        try {
          if ((await removeSessions(store, serve, id)) > 0) await removeSpaceRoot(workspace, id);
        } catch (error) {
          throw httpError(
            500,
            `スペースは削除しましたが、回収できない会話または作業フォルダが残っています: ${messageFor(error)}`,
          );
        }
      } finally {
        spaces.release(id);
      }
    },
  };
}

/**
 * 共有の公開枠が、このスペースの会話 (または起動元不明) で動いていれば 409 で止める。停止は削除に
 * 混ぜない (probe の失敗で「スペースは消えたがサービスは残った」状態を作らないため)。
 */
async function assertNoPublicService(serve: ServeService, spaceId: string): Promise<void> {
  // キャッシュを読むと、直前に起動したサービスを見落とす
  const runtime = await serve.runtimeStatus({ fresh: true });
  const ownedByOther = runtime.owner?.spaceId !== undefined && runtime.owner.spaceId !== spaceId;
  if (runtime.reachable && !ownedByOther) {
    throw httpError(409, "公開中のサービスがあります。設定 → ランタイムから停止してから削除してください");
  }
}

/** 会話ストアを使えないと履歴フォルダ (`<sessionId>/`) が残るため、消し始める前に止める */
function assertStoreReady(store: SessionStore): void {
  if (store.storeError) throw httpError(503, `会話ストアを利用できません: ${store.storeError}`);
  if (!store.storeDir) throw httpError(503, "スペースの削除には会話ストアが必要です");
}

/** そのスペースの会話を消す。所属を再確認し、引っ越し済みの会話は消さない。消した件数を返す */
async function removeSessions(store: SessionStore, serve: ServeService, spaceId: string): Promise<number> {
  let removed = 0;
  for (const summary of store.list(spaceId)) {
    if (!(await store.deleteSession(summary.sessionId, { expectSpaceId: spaceId }))) continue;
    removed += 1;
    // デバッグ用 serve の回収は削除の成否を変えない (失敗は warn だけ。残りはユーザーが回収する)
    await serve.discardDebug(summary.sessionId);
  }
  return removed;
}

/** 追加スペースの根をサンドボックスへ消させる。対象が無い 404 は成功 (再試行を冪等にする) */
async function removeSpaceRoot(workspace: SandboxWorkspaceClient, spaceId: string): Promise<void> {
  try {
    await workspace.deleteDirectory(spaceDirRel(spaceId));
  } catch (error) {
    if (error instanceof SandboxRequestError && error.status === 404) return;
    throw httpError(sandboxFailureStatus(error), messageFor(error));
  }
}
