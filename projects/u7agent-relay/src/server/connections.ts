import type { ApiKeyRecord, ConnectionRecord, Store } from "./db";
import { AdminError } from "./errors";
import { createToken, hashToken, tokenPrefix } from "./keys";
import {
  parseOrigin,
  parseSessionUrl,
  parseSpaceId,
  safeSessionUrl,
  sessionUrls,
  type ConnectionTarget,
} from "./targets";
import type { UpstreamClient } from "./upstream";

const MAX_NAME_LENGTH = 64;

export function parseName(value: unknown): string {
  if (typeof value !== "string") {
    throw new AdminError(400, "invalid_name");
  }

  const name = value.trim();

  if (name.length === 0 || name.length > MAX_NAME_LENGTH) {
    throw new AdminError(400, "invalid_name");
  }

  return name;
}

export type ConnectionView = ConnectionRecord & {
  sessionUrl: string | null;
  keyCount: number;
};

export type ConnectionService = ReturnType<typeof createConnectionService>;

export function createConnectionService(options: { store: Store; upstream: UpstreamClient; now: () => number }) {
  const { store, upstream, now } = options;

  function view(connection: ConnectionRecord): ConnectionView {
    return {
      ...connection,
      sessionUrl: safeSessionUrl(connection.origin, connection.sessionId, connection.spaceId),
      keyCount: store.countKeys(connection.id),
    };
  }

  function insert(name: string, target: ConnectionTarget): ConnectionRecord {
    const existing = store.findConnection(target);

    // 同じ会話を別名で登録すると、同じ会話に別々のキーが付いて結果の追跡先が分からなくなる。
    if (existing) {
      throw new AdminError(409, "duplicate_connection");
    }

    const at = now();
    const connection: ConnectionRecord = {
      id: crypto.randomUUID().replaceAll("-", "").slice(0, 8),
      name,
      origin: target.origin,
      sessionId: target.sessionId,
      spaceId: target.spaceId,
      createdAt: at,
      updatedAt: at,
    };

    store.insertConnection(connection);

    return connection;
  }

  return {
    view,

    list(): ConnectionView[] {
      return store.listConnections().map(view);
    },

    /** 既存の会話 URL を貼り付ける経路。 */
    addFromUrl(name: string, sessionUrl: string): ConnectionRecord {
      return insert(name, parseSessionUrl(sessionUrl));
    },

    /** u7agent に会話を作らせて、そのまま接続先にする経路。 */
    async addByCreatingSession(name: string, origin: string, spaceId: string): Promise<ConnectionRecord> {
      const target = await upstream.createSession(parseOrigin(origin), parseSpaceId(spaceId));

      return insert(name, target);
    },

    update(id: string, input: { name?: unknown; sessionUrl?: unknown }): ConnectionRecord {
      const current = store.getConnection(id);

      if (!current) {
        throw new AdminError(404, "connection_not_found");
      }

      const name = input.name === undefined ? current.name : parseName(input.name);
      const target =
        input.sessionUrl === undefined
          ? { origin: current.origin, sessionId: current.sessionId, spaceId: current.spaceId }
          : parseSessionUrl(String(input.sessionUrl));

      const existing = store.findConnection(target);

      if (existing && existing.id !== id) {
        throw new AdminError(409, "duplicate_connection");
      }

      store.updateConnection(id, name, target, now());

      const updated = store.getConnection(id);

      if (!updated) {
        throw new AdminError(404, "connection_not_found");
      }

      return updated;
    },

    remove(id: string): { deletedKeys: number } {
      if (!store.getConnection(id)) {
        throw new AdminError(404, "connection_not_found");
      }

      const deletedKeys = store.countKeys(id);

      store.deleteConnection(id);

      return { deletedKeys };
    },

    async check(id: string): Promise<{
      status: string;
      title: string | null;
      queueDepth: number;
      awaitingAnswer: boolean;
      sessionUrl: string;
      checkedAt: number;
    }> {
      const connection = store.getConnection(id);

      if (!connection) {
        throw new AdminError(404, "connection_not_found");
      }

      const session = await upstream.readSession(connection);
      const urls = sessionUrls(connection);

      return {
        status: session.status,
        title: session.title ?? null,
        queueDepth: session.queueDepth ?? 0,
        awaitingAnswer: session.awaitingAnswer === true,
        sessionUrl: urls.sessionUrl,
        checkedAt: now(),
      };
    },
  };
}

export type KeyView = {
  id: string;
  connectionId: string;
  name: string;
  prefix: string;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
};

export type KeyService = ReturnType<typeof createKeyService>;

export function createKeyService(options: { store: Store; now: () => number }) {
  const { store, now } = options;

  function toView(key: ApiKeyRecord): KeyView {
    return {
      id: key.id,
      connectionId: key.connectionId,
      name: key.name,
      prefix: key.prefix,
      createdAt: key.createdAt,
      lastUsedAt: key.lastUsedAt,
      revokedAt: key.revokedAt,
    };
  }

  function view(id: string): KeyView | null {
    const key = store.getKey(id);

    return key ? toView(key) : null;
  }

  return {
    list(): KeyView[] {
      return store.listKeys().map(toView);
    },

    /** 平文は返り値のときだけ。保存するのは SHA-256 で、画面を閉じたら再表示できない。 */
    create(input: { name: string; connectionId: string }): { key: KeyView; token: string } {
      if (!store.getConnection(input.connectionId)) {
        throw new AdminError(400, "connection_not_found");
      }

      const token = createToken();
      const at = now();
      const id = crypto.randomUUID().replaceAll("-", "").slice(0, 8);

      store.insertKey({
        id,
        connectionId: input.connectionId,
        name: input.name,
        prefix: tokenPrefix(token),
        hash: hashToken(token),
        createdAt: at,
      });

      const created = view(id);

      if (!created) {
        throw new Error("作成直後の API キーを読み出せません");
      }

      return { key: created, token };
    },

    revoke(id: string): KeyView {
      const key = store.getKey(id);

      if (!key) {
        throw new AdminError(404, "key_not_found");
      }

      if (key.revokedAt === null) {
        store.revokeKey(id, now());
      }

      const revoked = view(id);

      if (!revoked) {
        throw new AdminError(404, "key_not_found");
      }

      return revoked;
    },

    remove(id: string): void {
      if (!store.getKey(id)) {
        throw new AdminError(404, "key_not_found");
      }

      store.deleteKey(id);
    },
  };
}
