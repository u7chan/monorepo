// イメージ参照の解析。タグ切り替えの対象を「この monorepo の CD が GHCR に push した
// イメージ」に限定するため、レジストリ・リポジトリ・タグの分解を 1 箇所にまとめる。

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

/**
 * compose project 名として受け付けられる形式か。
 * deploy target は workflow 側でも targets.json と照合されるが、ここでも
 * GitHub へ渡す前に形を限定する。
 */
export function isValidDeployTarget(target: string): boolean {
  return DEPLOY_TARGET_PATTERN.test(target);
}
