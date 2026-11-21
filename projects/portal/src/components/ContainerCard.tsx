// ContainerCard Component - 1 つのコンテナを「ポートの入口」として見せるカード / 行

import { useConfig } from "../hooks/useConfig";
import { useDeploy } from "../hooks/useDeploy";
import type { ContainerAction } from "../lib/containerState";
import type { Container } from "../types/container";
import { Collapsible } from "./Collapsible";
import { ContainerActionSlot } from "./container/ContainerActionButton";
import { ContainerHeading } from "./container/ContainerHeading";
import { ContainerLinks } from "./container/ContainerLinks";
import { ImageField } from "./container/ImageField";
import { DeployButton, DeployPanel } from "./DeployControl";

export type { ContainerAction };

export interface ContainerCardProps {
  container: Container;
  pendingAction?: ContainerAction | null;
  onAction?: (container: Container, action: ContainerAction) => void;
}

/**
 * コンテナカード。上部が個体の識別と起動 / 停止、中央がポート (この画面の主役)、下部が補助情報。
 */
export function ContainerCard({ container, pendingAction, onAction }: ContainerCardProps) {
  const { config } = useConfig();
  const host = config?.host || "localhost";
  const deploy = useDeploy(container);

  return (
    <article className="group/card flex flex-col rounded-card bg-surface shadow-card">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2 px-4 pt-4">
        <ContainerHeading container={container} />
        <ContainerActionSlot
          container={container}
          pendingAction={pendingAction}
          onAction={onAction}
        />
      </div>

      <div className="px-4 pt-3 pb-4">
        <ContainerLinks container={container} host={host} />
      </div>

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-separator px-4 py-1.5">
        <div className="min-w-0 flex-1 basis-[11rem]">
          <ImageField image={container.image} />
        </div>
        {container.canDeploy && <DeployButton deploy={deploy} />}
      </div>

      {container.canDeploy && (
        <Collapsible open={deploy.isOpen}>
          <div className="border-t border-separator px-4 py-3">
            <DeployPanel deploy={deploy} />
          </div>
        </Collapsible>
      )}
    </article>
  );
}

/**
 * コンテナリスト行。1 つの面にまとめた行で、広い画面ではポートの位置が縦に揃うよう列を固定する。
 * 配置は index.css の .list-row が持つ (DOM の順序は、名前 → リンク → イメージ → 操作)。
 */
export function ContainerListItem({ container, pendingAction, onAction }: ContainerCardProps) {
  const { config } = useConfig();
  const host = config?.host || "localhost";
  const deploy = useDeploy(container);

  return (
    <article className="group/card px-4 py-3">
      <div className="list-row" data-can-deploy={container.canDeploy || undefined}>
        <div className="[grid-area:title]">
          <ContainerHeading container={container} />
        </div>
        <div className="min-w-0 [grid-area:links]">
          <ContainerLinks container={container} host={host} dense />
        </div>
        <div className="min-w-0 [grid-area:image]">
          <ImageField image={container.image} />
        </div>
        {container.canDeploy && (
          <div className="[grid-area:deploy]">
            <DeployButton deploy={deploy} />
          </div>
        )}
        <div className="justify-self-end [grid-area:stop]">
          <ContainerActionSlot
            container={container}
            pendingAction={pendingAction}
            onAction={onAction}
          />
        </div>
      </div>

      {container.canDeploy && (
        <Collapsible open={deploy.isOpen}>
          <div className="mt-3 border-t border-separator pt-3">
            <DeployPanel deploy={deploy} />
          </div>
        </Collapsible>
      )}
    </article>
  );
}

export default ContainerCard;
