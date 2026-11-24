/**
 * 端末 (オリジン) ごとの表示設定を localStorage の 1 キーで読み書きする store と、その保存先の解決。
 * キー・parse・serialize は各 module が持ち、メモリの控えと保存先の解決だけをここに置く
 * (docs/ui-layout.md)。
 */

/**
 * localStorage の代わりに使う最小の口。保存を消さない store (カテゴリの開閉など) もあるため、
 * removeItem は「未設定へ戻す」操作を持つ store の保存先だけが持つ。
 */
export type DeviceSettingsStorage = Pick<Storage, "getItem" | "setItem"> & Partial<Pick<Storage, "removeItem">>;

/**
 * 保存先を解決する。引数を省いたときだけ window.localStorage を使い、呼び出しごとに引き直す
 * (accessor 自体が例外になる環境と、window が無いテストの両方に対応する)。null は「保存先を使わない」の明示。
 */
export function deviceSettingsStorage(storage?: DeviceSettingsStorage | null): DeviceSettingsStorage | null {
  if (storage !== undefined) return storage;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export type DeviceSettingsStore<T> = {
  /** 保存値。保存先が無いときと読み取りに失敗したときは fallback の値 */
  read(): T;
  /** 書いた値をメモリに控える。serialize が null を返す値はキーごと消す */
  write(value: T): void;
};

export type DeviceSettingsStoreOptions<T> = {
  key: string;
  /** 保存済みの生値 → 値。壊れた値は未設定として扱う */
  parse(raw: string | null): T;
  /** 値 → 保存する文字列。null はキーごと消す */
  serialize(value: T): string | null;
  /** 書く前の正規化。読み手が捨てる形を書くと次の mount で表示が変わるため、保存する形へ寄せる */
  normalize?(value: T): T;
  /** 保存先が無いとき、読み取りに失敗したときに返す値。呼び出しごとに新しい値を返してよい */
  fallback(): T;
};

/**
 * 値を localStorage の 1 キーで読み書きする。保存領域が使えない環境 (private browsing 等) でも操作を
 * 止めず、代わりに同じセッション内のメモリを使う。write が失敗した後でも、再読み込みするまでは
 * 書いた値を保つ。
 */
export function createDeviceSettingsStore<T>(
  storage: DeviceSettingsStorage | null | undefined,
  options: DeviceSettingsStoreOptions<T>,
): DeviceSettingsStore<T> {
  // 一度でも読み書きしたら、以降はここが正 (書けなくても session 内は保つ)
  let memory: T | undefined;

  return {
    read() {
      if (memory !== undefined) return memory;
      const target = deviceSettingsStorage(storage);
      if (!target) return options.fallback();
      try {
        memory = options.parse(target.getItem(options.key));
        return memory;
      } catch {
        return options.fallback();
      }
    },
    write(value) {
      const next = options.normalize ? options.normalize(value) : value;
      memory = next;
      const target = deviceSettingsStorage(storage);
      if (!target) return;
      try {
        const text = options.serialize(next);
        if (text === null) target.removeItem?.(options.key);
        else target.setItem(options.key, text);
      } catch {
        // 保存できない。次の書き込みでまた試す
      }
    },
  };
}
