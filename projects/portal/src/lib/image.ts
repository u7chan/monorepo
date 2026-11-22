// イメージ参照の解析。タグ切り替えの対象を「この monorepo の CD が GHCR に push した
// イメージ」に限定するため、レジストリ・リポジトリ・タグの分解を 1 箇所にまとめる。

import type { ImageTagOption } from "../types/container";

const MONOREPO_IMAGE_PREFIX = "ghcr.io/u7chan/monorepo/";
const PROJECT_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const TAG_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const DEPLOY_TARGET_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export interface ImageReference {
  repository: string;
  tag?: string;
}

/**
 * "registry/repo:tag" / "registry/repo@sha256:..." / "repo" を分解する。
 * レジストリのポートとタグのコロンを区別するため、最後の "/" より後ろだけを見る。
 */
export function parseImageReference(image: string): ImageReference {
  const withoutDigest = image.split("@")[0] ?? "";
  const slash = withoutDigest.lastIndexOf("/");
  const colon = withoutDigest.lastIndexOf(":");

  if (colon > slash) {
    return {
      repository: withoutDigest.slice(0, colon),
      tag: withoutDigest.slice(colon + 1),
    };
  }

  return { repository: withoutDigest };
}

/**
 * digest を固定しているか。タグを併記していても (repo:tag@sha256:...)、
 * 動いているのは digest が指すビルドで、タグのビルドとは限らない。
 */
export function hasImageDigest(image: string): boolean {
  return image.includes("@");
}

export interface ImageDisplay {
  /** レジストリと名前空間。"ghcr.io/u7chan/monorepo/" のように末尾の "/" まで含む。無ければ空文字 */
  prefix: string;
  /** 最後のパス要素 (プロジェクト名) */
  name: string;
  /** ":latest" や "@sha256:0f4e2c9b1d7a" のように名前の後ろへ付く識別子。無ければ空文字 */
  version: string;
}

const DIGEST_PREVIEW_LENGTH = 12;

/**
 * 表示用に、プレフィックス・名前・識別子 (タグ / 短縮ダイジェスト) へ分ける。
 * 長いイメージ名を省略するとき、プレフィックスから先に省略して、名前と識別子を残すため。
 * 末尾を単純に切ると、いちばん知りたい「どのタグか」から先に消える。
 */
export function describeImage(image: string): ImageDisplay {
  const { repository, tag } = parseImageReference(image);
  const digestStart = image.indexOf("@");
  const digest = digestStart === -1 ? undefined : image.slice(digestStart + 1);
  const nameStart = repository.lastIndexOf("/") + 1;

  return {
    prefix: repository.slice(0, nameStart),
    name: repository.slice(nameStart),
    version: `${tag ? `:${tag}` : ""}${digest ? `@${shortenDigest(digest)}` : ""}`,
  };
}

function shortenDigest(digest: string): string {
  const separator = digest.indexOf(":");
  const algorithm = separator === -1 ? "" : digest.slice(0, separator + 1);
  const hash = separator === -1 ? digest : digest.slice(separator + 1);

  return `${algorithm}${hash.slice(0, DIGEST_PREVIEW_LENGTH)}`;
}

/**
 * monorepo の CD がビルドする GHCR イメージだけを対象にする。
 * Docker Hub や第三者の GHCR は、タグの意味と更新方針を portal が知らないため
 * 切り替え対象にしない。
 */
export function monorepoProject(image: string): string | undefined {
  const { repository } = parseImageReference(image);
  if (!repository.startsWith(MONOREPO_IMAGE_PREFIX)) {
    return undefined;
  }

  const project = repository.slice(MONOREPO_IMAGE_PREFIX.length);
  return PROJECT_PATTERN.test(project) ? project : undefined;
}

/**
 * Docker のタグ名として受け付けられる形式か。
 * workflow_dispatch の inputs へ渡す前にここで弾き、余計な文字を混ぜない。
 */
export function isValidImageTag(tag: string): boolean {
  return TAG_PATTERN.test(tag);
}

/**
 * デプロイに渡せるタグか。latest は可変で、require_image_tag の target が
 * 拒否するため、選択肢にも送信にも使わない。
 */
export function isDeployableImageTag(tag: string): boolean {
  return isValidImageTag(tag) && tag !== "latest";
}

function builtAt(createdAt: string | undefined): number | undefined {
  return createdAt ? parseTimestamp(createdAt) : undefined;
}

// GitHub Packages の created_at は UTC の ISO 8601。Date.parse だけでは
// 2 月 30 日のような存在しない暦日を補正してしまうため、書かれた構成要素と
// UTC へ戻した値が一致するときだけ受け付ける。
const TIMESTAMP_PATTERN =
  /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})T(?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2})(?:\.\d+)?Z$/;

function parseTimestamp(createdAt: string): number | undefined {
  const groups = TIMESTAMP_PATTERN.exec(createdAt)?.groups;
  if (!groups) {
    return undefined;
  }

  const time = Date.parse(createdAt);
  if (Number.isNaN(time)) {
    return undefined;
  }

  const date = new Date(time);
  if (
    date.getUTCFullYear() !== Number(groups.year) ||
    date.getUTCMonth() !== Number(groups.month) - 1 ||
    date.getUTCDate() !== Number(groups.day) ||
    date.getUTCHours() !== Number(groups.hour) ||
    date.getUTCMinutes() !== Number(groups.minute) ||
    date.getUTCSeconds() !== Number(groups.second)
  ) {
    return undefined;
  }

  return time;
}

function tagBuiltAt(tags: readonly ImageTagOption[], tag: string): number | undefined {
  return builtAt(tags.find((option) => option.tag === tag)?.createdAt);
}

/**
 * 稼働中のタグより後にビルドされたタグのうち、最新のものを返す。
 *
 * Why not: 現在のタグが一覧に無いときは比較しない。latest やダイジェスト参照は
 * どのビルドが動いているかを portal が知らないため、「新着」と断定できない。
 * 同じビルドの sha-* と manual-* は createdAt が同じなので、新着にはしない。
 */
export function findNewerImageTag(
  tags: readonly ImageTagOption[],
  currentTag: string,
): ImageTagOption | undefined {
  const current = tagBuiltAt(tags, currentTag);
  if (current === undefined) {
    return undefined;
  }

  let newest: ImageTagOption | undefined;
  let newestTime = current;

  for (const option of tags) {
    const time = builtAt(option.createdAt);
    if (time !== undefined && time > newestTime) {
      newest = option;
      newestTime = time;
    }
  }

  return newest;
}

/**
 * 選択したタグが current より前のビルドか。
 *
 * 確認は操作ミスへのガードレールなので、比較できないときは出さない。
 * 誤爆すると確認自体が読み飛ばされ、本来止めたい切り替えも素通りする。
 * createdAt が同じ sha-* と manual-* は同じビルドなので、切り替えても対象外。
 */
export function isOlderImageTag(
  tags: readonly ImageTagOption[],
  currentTag: string,
  selectedTag: string,
): boolean {
  const current = tagBuiltAt(tags, currentTag);
  const selected = tagBuiltAt(tags, selectedTag);

  if (current === undefined || selected === undefined) {
    return false;
  }

  return selected < current;
}

/**
 * compose project 名として受け付けられる形式か。
 * deploy target は workflow 側でも targets.json と照合されるが、ここでも
 * GitHub へ渡す前に形を限定する。
 */
export function isValidDeployTarget(target: string): boolean {
  return DEPLOY_TARGET_PATTERN.test(target);
}
