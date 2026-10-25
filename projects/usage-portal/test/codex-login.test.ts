// Codex サインインの状態機械（SDK との対話、終端、中断、期限）を固定する。
import { afterEach, describe, expect, test } from "bun:test";
import type { AuthInteraction } from "@earendil-works/pi-ai";
import {
  CodexLoginError,
  createCodexLoginService,
  type CodexLoginService,
  type CodexLoginState,
} from "../src/server/codex/login";

type Scenario = (interaction: AuthInteraction) => Promise<void>;

const services: CodexLoginService[] = [];

function harness(scenario: Scenario, options: { deadlineMs?: number; onSuccess?: () => Promise<void> } = {}) {
  const logs: string[] = [];
  const service = createCodexLoginService({
    auth: { login: scenario },
    onSuccess: options.onSuccess ?? (async () => {}),
    deadlineMs: options.deadlineMs ?? 600_000,
    authUrlWaitMs: 0,
    log: (message) => logs.push(message),
  });

  services.push(service);

  return { service, logs };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("状態が変わりませんでした");
    }

    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function state(service: CodexLoginService): CodexLoginState | null {
  return service.state();
}

afterEach(() => {
  for (const service of services.splice(0)) {
    if (service.state()?.status === "running") {
      service.cancel();
    }
  }
});

describe("サインイン方法の選択とデバイスコード", () => {
  test("select の選択肢を Portal の文言で出し、device_code の URL とコードを表示する", async () => {
    const { service } = harness(async (interaction) => {
      const method = await interaction.prompt({
        type: "select",
        message: "Select OpenAI Codex login method:",
        options: [
          { id: "browser", label: "Browser login (default)" },
          { id: "device_code", label: "Device code login (headless)" },
        ],
      });

      expect(method).toBe("device_code");

      interaction.notify({
        type: "device_code",
        userCode: "ABCD-EFGH",
        verificationUri: "https://auth.example.invalid/codex/device",
        intervalSeconds: 5,
      });
      // 認可待ちの間は進行中のまま。SDK は承認まで返らない。
      await new Promise(() => {});
    });

    await service.start();

    const prompt = state(service)?.prompt;

    expect(prompt?.type).toBe("select");
    expect(prompt?.type === "select" ? prompt.options.map((option) => option.id) : []).toEqual([
      "browser",
      "device_code",
    ]);
    expect(prompt?.type === "select" ? prompt.message : "").not.toContain("Select");

    service.respond("device_code");
    await waitFor(() => state(service)?.userCode !== null);

    expect(state(service)).toMatchObject({
      status: "running",
      userCode: "ABCD-EFGH",
      authUrl: "https://auth.example.invalid/codex/device",
      instructions: "ブラウザでこの URL を開き、画面に表示されたコードを入力して承認してください",
    });

    service.cancel();
  });

  test("select の選択肢に無い値は invalid_response、待っていなければ no_prompt", async () => {
    const { service } = harness(async (interaction) => {
      await interaction.prompt({ type: "select", message: "m", options: [{ id: "device_code", label: "d" }] });
    });

    await service.start();
    await waitFor(() => state(service)?.prompt !== null);

    expect(() => service.respond("browser")).toThrow(CodexLoginError);

    try {
      service.respond("browser");
    } catch (error) {
      expect((error as CodexLoginError).reason).toBe("invalid_response");
    }

    service.respond("device_code");
    await waitFor(() => state(service)?.prompt === null);
    await waitFor(() => state(service)?.status === "succeeded");

    try {
      service.respond("device_code");
    } catch (error) {
      expect((error as CodexLoginError).reason).toBe("not_running");
    }
  });
});

describe("ブラウザサインインと貼り付け", () => {
  test("auth_url の案内は固定の日本語にし、貼り付けを待つ", async () => {
    const received: string[] = [];
    const { service } = harness(async (interaction) => {
      interaction.notify({
        type: "auth_url",
        url: "https://auth.example.invalid/oauth/authorize?client_id=public-id",
        instructions: "A browser window should open. Complete login to finish.",
      });
      // `info` は画面に出す情報を持たない。
      interaction.notify({ type: "info", message: "Some SDK text with https://example.invalid/info" });

      received.push(
        await interaction.prompt({
          type: "manual_code",
          message: "Complete login in your browser, or paste the authorization code / redirect URL here:",
          placeholder: "http://localhost:1455/auth/callback",
        }),
      );
    });

    await service.start();
    await waitFor(() => state(service)?.prompt !== null);

    expect(state(service)?.instructions).toBe(
      "ブラウザのタブで承認してください。承認が終わると、この画面の表示が自動で更新されます",
    );
    expect(state(service)?.authUrl).toBe("https://auth.example.invalid/oauth/authorize?client_id=public-id");
    expect(state(service)?.prompt).toMatchObject({ type: "manual_code" });
    expect(state(service)?.prompt?.message).not.toContain("Complete login");

    service.respond("http://localhost:1455/auth/callback?code=abc&state=xyz");
    await waitFor(() => state(service)?.status === "succeeded");

    expect(received).toEqual(["http://localhost:1455/auth/callback?code=abc&state=xyz"]);
    // 終端では認可 URL・コード・入力欄を落とす。
    expect(state(service)).toEqual({
      status: "succeeded",
      instructions: null,
      progress: null,
      authUrl: null,
      userCode: null,
      prompt: null,
      error: null,
    });
  });

  test("コールバックが勝って prompt.signal が abort したら入力欄を閉じ、以後の貼り付けを拒否する", async () => {
    const control: { abort: (() => void) | null } = { abort: null };

    const { service } = harness(async (interaction) => {
      interaction.notify({ type: "auth_url", url: "https://auth.example.invalid/oauth/authorize" });

      const controller = new AbortController();

      control.abort = () => controller.abort();

      await interaction
        .prompt({ type: "manual_code", message: "paste", signal: controller.signal })
        .catch(() => "aborted");
    });

    await service.start();
    await waitFor(() => state(service)?.prompt !== null);

    control.abort?.();
    await waitFor(() => state(service)?.prompt === null);

    try {
      service.respond("http://localhost:1455/auth/callback?code=late");
    } catch (error) {
      expect((error as CodexLoginError).reason).toBe("no_prompt");
    }

    // abort は失敗ではなく、SDK 側の完了（成功・失敗）を待つだけ。
    await waitFor(() => state(service)?.status === "succeeded");
  });

  test("progress は既知の文言だけ日本語へ写し、未知は汎用文へ寄せる", async () => {
    const { service } = harness(async (interaction) => {
      interaction.notify({ type: "auth_url", url: "https://auth.example.invalid/oauth/authorize" });
      interaction.notify({ type: "progress", message: "Listening for OAuth callback on 127.0.0.1:1455" });
      await new Promise(() => {});
    });

    await service.start();
    await waitFor(() => state(service)?.progress !== null);

    expect(state(service)?.progress).toBe("ブラウザからのコールバックを待っています");

    service.cancel();
  });
});

describe("失敗と中断", () => {
  test("text / secret の対話はこの画面では扱えない方式として失敗させる", async () => {
    const { service, logs } = harness(async (interaction) => {
      await interaction.prompt({ type: "text", message: "Paste your API key" });
    });

    await service.start();
    await waitFor(() => state(service)?.status === "failed");

    expect(state(service)?.error).toBe(
      "この画面では扱えないサインイン方式です。デバイスコードと貼り付けの方式だけに対応しています",
    );
    expect(logs).toEqual(["codex login failed (unsupported)"]);
  });

  test("SDK の生の例外文は応答にもログにも出さない", async () => {
    const { service, logs } = harness(async () => {
      throw new Error("EADDRINUSE: 127.0.0.1:1455 token=secret-sentinel");
    });

    await service.start();
    await waitFor(() => state(service)?.status === "failed");

    expect(state(service)?.error).toContain("コールバックポート（1455）が使用中");
    expect(JSON.stringify(state(service))).not.toContain("sentinel");
    expect(logs).toEqual(["codex login failed (port_in_use)"]);
  });

  test("失敗の分類は固定文言へ寄せる", async () => {
    const { service } = harness(async () => {
      throw new Error("access_denied: user rejected");
    });

    await service.start();
    await waitFor(() => state(service)?.status === "failed");

    expect(state(service)?.error).toContain("サインインが承認されませんでした");
  });

  test("中断は冪等で、終端の表示をもう一度消せる", async () => {
    const { service } = harness(async () => {
      await new Promise(() => {});
    });

    await service.start();
    service.cancel();

    expect(state(service)?.status).toBe("cancelled");
    expect(state(service)?.authUrl).toBeNull();

    // 進行中でない中断は表示を消すだけ。
    service.cancel();
    expect(state(service)).toBeNull();
  });

  test("進行中の二重開始は 409 相当の in_progress", async () => {
    const { service } = harness(async () => {
      await new Promise(() => {});
    });

    await service.start();

    try {
      await service.start();
      throw new Error("二重開始できてしまいました");
    } catch (error) {
      expect(error).toBeInstanceOf(CodexLoginError);
      expect((error as CodexLoginError).reason).toBe("in_progress");
    }

    service.cancel();
  });

  test("開始から 10 分（テストでは短縮）で自動中断し、失敗として伝える", async () => {
    const { service, logs } = harness(
      async () => {
        await new Promise(() => {});
      },
      { deadlineMs: 10 },
    );

    await service.start();
    await waitFor(() => state(service)?.status === "failed");

    expect(state(service)?.error).toContain("一定時間内に承認されなかった");
    expect(logs).toEqual(["codex login failed (timeout)"]);
  });
});

describe("成功の公開順", () => {
  test("sampler の完了を待ってから succeeded を公開する", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let refreshes = 0;
    const { service } = harness(
      async (interaction) => {
        interaction.notify({ type: "auth_url", url: "https://auth.example.invalid/oauth/authorize" });
      },
      {
        onSuccess: async () => {
          refreshes += 1;
          await gate;
        },
      },
    );

    await service.start();
    await waitFor(() => refreshes === 1);
    expect(state(service)?.status).toBe("running");
    expect(state(service)?.authUrl).toBeNull();

    release();
    await waitFor(() => state(service)?.status === "succeeded");
  });
});
