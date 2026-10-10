/**
 * 作業フォルダ (cwd) 単位の環境変数ストア。所有者は会話ではなく cwd で、プロジェクト所属なら
 * 登録ディレクトリ、未所属なら所属スペースのスクラッチ (通常スペースは `.u7agent/sessions/<id>`) を共有する。種別は平文の「変数」と
 * 暗号化して保存する「シークレット」で、シークレットは値を返す経路を持たない。
 * 設計 (名前 / 値の規則、注入経路、保証範囲) は docs/secrets.md を正とする。
 */
import { createHash, randomUUID } from "node:crypto";
import type { SecretRow } from "./app-db";
import { envNameProblem, isPublicEnvName, normalizeEnvName } from "./env-names";
import { httpError } from "./http";
import { MIN_SECRET_LENGTH } from "./redact";
import { SecretKeyError, type SecretCipher, type SecretKind } from "./secret-crypto";

/** 変数の値の上限 (文字数)。小さな設定値向けで、長い本文はファイルへ置かせる */
export const VARIABLE_VALUE_MAX_LENGTH = 4096;
/** シークレットの値の上限 (UTF-8 バイト数)。接続文字列や JWT を想定する */
export const SECRET_VALUE_MAX_BYTES = 8192;

export interface SecretListItem {
  secretId: string;
  name: string;
  kind: SecretKind;
  /** epoch ms */
  updatedAt: number;
}

/** 変更フォーム用。値は「変数」だけに載り、シークレットでは常に省略される */
export interface SecretDetail extends SecretListItem {
  value?: string;
}

export interface SecretsList {
  items: SecretListItem[];
  /** この cwd の現在の世代 (起動時の値と比較して「再起動で反映」を出せるようにする) */
  generation: string;
  /** cwd が登録プロジェクトのディレクトリか (UI の「このプロジェクトの設定です」の根拠) */
  projectScoped: boolean;
}

export interface SecretMutation {
  item: SecretListItem;
  /** 前後の空白 / 改行を除去したか。UI は 1 行の注記を出す (無言で加工しない) */
  trimmed: boolean;
  generation: string;
}

/** serve の起動時に渡す値。キーの解決に失敗したシークレットはここで例外になる */
export interface ServiceEnv {
  variables: Record<string, string>;
  secrets: Record<string, string>;
  generation: string;
}

/** AppDb のうち、このストアが必要とする読み書き。テストはメモリ DB か、この形のスタブを渡す */
export interface SecretStore {
  listSecrets(cwd: string): SecretRow[];
  getSecret(secretId: string): SecretRow | undefined;
  findSecretByName(cwd: string, name: string): SecretRow | undefined;
  insertSecret(row: SecretRow): void;
  updateSecretValue(
    secretId: string,
    patch: {
      plaintext: string | null;
      ciphertext: Uint8Array | null;
      nonce: Uint8Array | null;
      keyVersion: number | null;
      updatedAt: number;
    },
  ): void;
  deleteSecret(secretId: string): boolean;
  nextSecretSortOrder(cwd: string): number;
}

/** 要求元の特定。会話 (sessionId) か、まだ会話が無いプロジェクト起点の新規会話 (projectId) のどちらか */
export interface SecretScopeInput {
  sessionId?: string | undefined;
  projectId?: string | undefined;
}

export interface SecretScope {
  /** rootCwd 相対の作業フォルダ */
  cwd: string;
  projectScoped: boolean;
}

export interface SecretScopeDeps {
  /** 会話 id → 作業ディレクトリ。未知の会話は undefined (ServeSessionLookup と同じ形) */
  sessions: { workdirOfId(id: string): string | undefined };
  /** プロジェクト id → 登録ディレクトリ */
  projects: { get(id: string): { cwd: string } | undefined; findByCwd(cwd: string): unknown };
}

/**
 * 要求元を cwd へ解決する唯一の点。会話 id は作業ディレクトリを引き、会話がまだ無いプロジェクト起点の
 * 新規会話はプロジェクト id を引く。両方 / どちらも無い指定は受け付けない (曖昧なまま操作させない)。
 */
export function createSecretScope({ sessions, projects }: SecretScopeDeps) {
  return {
    resolve(input: SecretScopeInput): SecretScope {
      const sessionId = input.sessionId?.trim() ?? "";
      const projectId = input.projectId?.trim() ?? "";
      if (sessionId && projectId) throw httpError(400, "sessionId と projectId はどちらか一方だけ指定できます");
      if (sessionId) {
        const cwd = sessions.workdirOfId(sessionId);
        if (cwd === undefined) throw httpError(404, "Session not found");
        return { cwd, projectScoped: Boolean(projects.findByCwd(cwd)) };
      }
      if (projectId) {
        const project = projects.get(projectId);
        if (!project) throw httpError(404, "Project not found");
        return { cwd: project.cwd, projectScoped: true };
      }
      throw httpError(400, "sessionId か projectId が必要です");
    },
  };
}

export type SecretScopeResolver = ReturnType<typeof createSecretScope>;

/** 名前の正規化と検証。入力の trim → 大文字化 → 使用可能文字 / 予約 / 公開プレフィックス */
export function normalizeSecretName(raw: string, kind: SecretKind): string {
  const name = normalizeEnvName(raw);
  const problem = envNameProblem(name);
  if (problem) throw httpError(400, problem);
  if (kind === "secret" && isPublicEnvName(name)) {
    throw httpError(
      400,
      `${name} はブラウザのバンドルへ値が入る接頭辞のため、シークレットには使えません（値がブラウザへ配られるためです）`,
    );
  }
  return name;
}

export interface NormalizedSecretValue {
  value: string;
  trimmed: boolean;
}

/**
 * 値の正規化と検証。CRLF は LF へ寄せ、前後の空白 / 改行を除去し、その事実を返す (無言で加工しない)。
 * NUL と空値は拒否する (未設定にしたいときは削除する)。
 */
export function normalizeSecretValue(raw: string, kind: SecretKind): NormalizedSecretValue {
  if (raw.includes("\0")) throw httpError(400, "値に NUL 文字は使えません");
  const normalized = raw.replace(/\r\n?/g, "\n");
  const value = normalized.trim();
  if (value === "") throw httpError(400, "値は必須です（未設定にしたいときは削除してください）");
  if (kind === "variable") {
    if (value.length > VARIABLE_VALUE_MAX_LENGTH) {
      throw httpError(400, `変数の値は ${VARIABLE_VALUE_MAX_LENGTH} 文字以内にしてください`);
    }
  } else if (Buffer.byteLength(value, "utf8") > SECRET_VALUE_MAX_BYTES) {
    throw httpError(400, `シークレットの値は ${SECRET_VALUE_MAX_BYTES} バイト以内にしてください`);
  }
  return { value, trimmed: value !== normalized };
}

/**
 * cwd 内の世代。名前 → (secret_id, 更新時刻) を畳んだ短いハッシュで、起動時に記録した値と比べれば
 * 「次回の起動で反映される変更がある」と分かる。値そのものは含めない。
 */
export function secretGeneration(rows: readonly SecretRow[]): string {
  const lines = [...rows]
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    .map((row) => `${row.name}\u0000${row.secretId}\u0000${row.updatedAt}`);
  if (lines.length === 0) return "";
  return createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 16);
}

function itemOf(row: SecretRow): SecretListItem {
  return { secretId: row.secretId, name: row.name, kind: row.kind, updatedAt: row.updatedAt };
}

export interface SecretServiceOptions {
  store: SecretStore;
  /** 復号不能な鍵では null。シークレットの登録・復号を拒否する (変数は平文で続行する) */
  cipher: SecretCipher | null;
  /** cipher が null の理由 (鍵が未設定 / 宣言が壊れている)。利用を拒否するときの文言に使う */
  unavailableReason?: string;
  /** マスカーへ値を登録する。保存時 (DB へ書く前) と起動時の復号時の両方で呼ぶ */
  retainSecret: (value: string) => void;
  now?: () => number;
  newId?: () => string;
}

/**
 * 保存時のマスカー登録は「値を受け取った直後」に、復号時は値を得た直後に行う。
 * 8 文字未満は登録しない (短い値は会話本文を軒並み [REDACTED] にするため。UI にその旨を出す)。
 */
function retainIfLongEnough(retainSecret: (value: string) => void, value: string): void {
  if (value.length >= MIN_SECRET_LENGTH) retainSecret(value);
}

export class SecretService {
  #store: SecretStore;
  #cipher: SecretCipher | null;
  #unavailableReason: string;
  #retainSecret: (value: string) => void;
  #now: () => number;
  #newId: () => string;

  constructor(options: SecretServiceOptions) {
    this.#store = options.store;
    this.#cipher = options.cipher;
    this.#unavailableReason =
      options.unavailableReason ??
      "シークレットの master key が設定されていません (U7AGENT_SECRET_MASTER_KEY)。値を保存・利用するには設定が必要です";
    this.#retainSecret = options.retainSecret;
    this.#now = options.now ?? (() => Date.now());
    this.#newId = options.newId ?? randomUUID;
  }

  /** 行があるのに鍵が無い状態でシークレットを読もうとしたときの境界。平文保存 / 秘密なし起動へ落とさない */
  #requireCipher(): SecretCipher {
    if (!this.#cipher) throw httpError(503, this.#unavailableReason);
    return this.#cipher;
  }

  /** cwd の行。鍵に関係なく読める (一覧は名前・種別・更新時刻だけを返す) */
  #rows(cwd: string): SecretRow[] {
    return this.#store.listSecrets(cwd);
  }

  list(scope: SecretScope): SecretsList {
    const rows = this.#rows(scope.cwd);
    return { items: rows.map(itemOf), generation: secretGeneration(rows), projectScoped: scope.projectScoped };
  }

  /** 変更フォーム用の詳細。値は変数のときだけ載せ、シークレットでは決して返さない */
  detail(scope: SecretScope, secretId: string): SecretDetail {
    const row = this.#find(scope, secretId);
    if (row.kind !== "variable") return itemOf(row);
    return { ...itemOf(row), value: row.plaintext ?? "" };
  }

  create(scope: SecretScope, input: { kind: SecretKind; name: string; value: string }): SecretMutation {
    const name = normalizeSecretName(input.name, input.kind);
    if (this.#store.findSecretByName(scope.cwd, name)) {
      throw httpError(409, `${name} はすでに登録されています（変更は値を上書きしてください）`);
    }
    const { value, trimmed } = normalizeSecretValue(input.value, input.kind);
    const now = this.#now();
    const row: SecretRow = {
      secretId: this.#newId(),
      cwd: scope.cwd,
      name,
      kind: input.kind,
      plaintext: null,
      ciphertext: null,
      nonce: null,
      keyVersion: null,
      sortOrder: this.#store.nextSecretSortOrder(scope.cwd),
      createdAt: now,
      updatedAt: now,
    };
    if (input.kind === "variable") {
      // 変数はエージェントにも見えてよい値なので、マスカーへは登録しない (NODE_ENV などの誤爆を避ける)
      row.plaintext = value;
    } else {
      const cipher = this.#requireCipher();
      retainIfLongEnough(this.#retainSecret, value);
      const encrypted = cipher.encrypt(row.kind, row.name, value);
      row.ciphertext = encrypted.ciphertext;
      row.nonce = encrypted.nonce;
      row.keyVersion = encrypted.keyVersion;
    }
    this.#store.insertSecret(row);
    return { item: itemOf(row), trimmed, generation: this.#generation(scope.cwd) };
  }

  /** 値の上書きのみ。名前と種別は変えられない (変えたいときは削除して作り直す) */
  updateValue(scope: SecretScope, secretId: string, rawValue: string): SecretMutation {
    const row = this.#find(scope, secretId);
    const { value, trimmed } = normalizeSecretValue(rawValue, row.kind);
    const updatedAt = this.#now();
    if (row.kind === "variable") {
      this.#store.updateSecretValue(row.secretId, {
        plaintext: value,
        ciphertext: null,
        nonce: null,
        keyVersion: null,
        updatedAt,
      });
    } else {
      const cipher = this.#requireCipher();
      retainIfLongEnough(this.#retainSecret, value);
      const encrypted = cipher.encrypt(row.kind, row.name, value);
      this.#store.updateSecretValue(row.secretId, {
        plaintext: null,
        ciphertext: encrypted.ciphertext,
        nonce: encrypted.nonce,
        keyVersion: encrypted.keyVersion,
        updatedAt,
      });
    }
    return {
      item: { secretId: row.secretId, name: row.name, kind: row.kind, updatedAt },
      trimmed,
      generation: this.#generation(scope.cwd),
    };
  }

  remove(scope: SecretScope, secretId: string): { removed: true; generation: string } {
    const row = this.#find(scope, secretId);
    this.#store.deleteSecret(row.secretId);
    return { removed: true, generation: this.#generation(scope.cwd) };
  }

  /**
   * 変数だけを返す (エージェントの bash 用)。シークレットはここに含めないため、鍵が未設定でも
   * bash は止まらない。
   */
  variablesFor(cwd: string): Record<string, string> {
    const variables: Record<string, string> = {};
    for (const row of this.#rows(cwd)) {
      if (row.kind !== "variable" || row.plaintext === null) continue;
      variables[row.name] = row.plaintext;
    }
    return variables;
  }

  /**
   * serve の起動時に渡す env。復号に失敗したら部分適用せず例外にする (秘密なし起動へ黙って落とさない)。
   * 復号した値は同時にマスカーへ登録する。
   */
  resolveServiceEnv(cwd: string): ServiceEnv {
    const rows = this.#rows(cwd);
    const variables: Record<string, string> = {};
    const secrets: Record<string, string> = {};
    for (const row of rows) {
      if (row.kind === "variable") {
        if (row.plaintext !== null) variables[row.name] = row.plaintext;
        continue;
      }
      if (row.ciphertext === null || row.nonce === null || row.keyVersion === null) {
        throw httpError(503, `シークレット「${row.name}」の保存値が欠けているため起動できません`);
      }
      const cipher = this.#requireCipher();
      let value: string;
      try {
        value = cipher.decrypt(row.kind, row.name, {
          ciphertext: row.ciphertext,
          nonce: row.nonce,
          keyVersion: row.keyVersion,
        });
      } catch (error) {
        if (error instanceof SecretKeyError) {
          throw httpError(503, `シークレット「${row.name}」を利用できません: ${error.message}`);
        }
        throw error;
      }
      retainIfLongEnough(this.#retainSecret, value);
      secrets[row.name] = value;
    }
    return { variables, secrets, generation: secretGeneration(rows) };
  }

  #generation(cwd: string): string {
    return secretGeneration(this.#rows(cwd));
  }

  /** cwd の行だけを操作対象にする (他会話の secret_id を指定しても届かない) */
  #find(scope: SecretScope, secretId: string): SecretRow {
    const row = this.#store.getSecret(secretId);
    if (!row || row.cwd !== scope.cwd) throw httpError(404, "環境変数が見つかりません");
    return row;
  }
}
