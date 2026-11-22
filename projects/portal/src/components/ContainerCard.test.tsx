// ContainerCard の表示契約テスト。DOM は使わず、SSR のマークアップだけを見る。

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Container } from "../types/container";
import { ContainerCard, ContainerListItem } from "./ContainerCard";

function container(overrides: Partial<Container> = {}): Container {
  return {
    id: "abc123",
    name: "app",
    image: "ghcr.io/u7chan/monorepo/app:sha-1234567",
    state: "running",
    status: "Up 3 days",
    ports: [],
    ...overrides,
  };
}

const PORT = { host: "0.0.0.0", publicPort: 3000, privatePort: 80, protocol: "tcp" };
const UPDATE = {
  containerId: "abc123",
  latestTag: "sha-7654321",
  createdAt: "2026-11-13T13:06:22Z",
};

function renderCard(overrides: Partial<Container> = {}): string {
  return renderToStaticMarkup(<ContainerCard container={container(overrides)} />);
}

function renderListItem(overrides: Partial<Container> = {}): string {
  return renderToStaticMarkup(<ContainerListItem container={container(overrides)} />);
}

describe("ContainerCard", () => {
  test("コンテナ名と status を描画する", () => {
    const markup = renderCard();

    expect(markup).toContain('title="app">app</h3>');
    expect(markup).toContain("Up 3 days");
  });

  test("status が空なら state を描画する", () => {
    const markup = renderCard({ state: "exited", status: "" });

    expect(markup).toContain(">exited</span>");
  });

  test("running の公開ポートは http://<host>:<port> のリンクにする", () => {
    const markup = renderCard({ ports: [PORT] });

    expect(markup).toContain('href="http://localhost:3000"');
    expect(markup).toContain('title="http://localhost:3000"');
  });

  test("exited のポートはリンクにせず offline の title を持つ", () => {
    const markup = renderCard({ state: "exited", ports: [PORT] });

    expect(markup).not.toContain('href="http://localhost:3000"');
    expect(markup).toContain('title="localhost:3000 is offline until the container starts"');
  });

  test("hidden は公開ポートがあっても Links hidden を出す", () => {
    const markup = renderCard({ hidden: true, ports: [PORT] });

    expect(markup).toContain("Links hidden");
    expect(markup).not.toContain("No published ports");
    expect(markup).not.toContain('href="http://localhost:3000"');
  });

  test("url 指定はポートではなくホスト名のタイルにする", () => {
    const markup = renderCard({ url: "https://portal.example", ports: [PORT] });

    expect(markup).toContain('href="https://portal.example"');
    expect(markup).toContain("portal.<wbr/>example");
    expect(markup).not.toContain(">3000</span>");
  });

  test("canDeploy でないコンテナに Deploy ボタンを出さない", () => {
    const markup = renderCard();

    expect(markup).not.toContain("<span>Deploy</span>");
  });

  test("canDeploy のコンテナに Deploy ボタンを出す", () => {
    const markup = renderCard({ canDeploy: true, deployTarget: "app" });

    expect(markup).toContain("<span>Deploy</span>");
  });

  test("canDeploy のコンテナで新着があれば New を出す", () => {
    const markup = renderToStaticMarkup(
      <ContainerCard
        container={container({ canDeploy: true, deployTarget: "app" })}
        update={UPDATE}
      />,
    );

    expect(markup).toContain("New");
    expect(markup).toContain(
      'title="A newer image (sha-7654321) was built at 2026-11-13 22:06:22 (JST)."',
    );
  });

  test("新着があっても canDeploy でなければ New を出さない", () => {
    const markup = renderToStaticMarkup(<ContainerCard container={container()} update={UPDATE} />);

    expect(markup).not.toContain("image available");
  });

  test("新着が無ければ New を出さない", () => {
    const markup = renderCard({ canDeploy: true, deployTarget: "app" });

    expect(markup).not.toContain("image available");
  });
});

describe("ContainerListItem", () => {
  test("コンテナ名と status を描画する", () => {
    const markup = renderListItem();

    expect(markup).toContain('title="app">app</h3>');
    expect(markup).toContain("Up 3 days");
  });

  test("running の公開ポートをリンクにする", () => {
    const markup = renderListItem({ ports: [PORT] });

    expect(markup).toContain('href="http://localhost:3000"');
  });

  test("canDeploy の行だけ data-can-deploy を持つ", () => {
    expect(renderListItem()).not.toContain("data-can-deploy");
    expect(renderListItem({ canDeploy: true, deployTarget: "app" })).toContain(
      'data-can-deploy="true"',
    );
  });

  test("新着があれば Deploy の隣に New を出す", () => {
    const markup = renderToStaticMarkup(
      <ContainerListItem
        container={container({ canDeploy: true, deployTarget: "app" })}
        update={UPDATE}
      />,
    );

    expect(markup).toContain("New");
    expect(markup).toContain("image available");
  });
});
