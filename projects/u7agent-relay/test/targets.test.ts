// 会話 URL の解釈と、上流 API の URL 組み立てを固定する。
import { describe, expect, test } from "bun:test";
import { AdminError } from "../src/server/errors";
import {
  parseOrigin,
  parseSessionUrl,
  parseSpaceId,
  fileUrls,
  safeSessionUrl,
  sessionUrls,
} from "../src/server/targets";

describe("parseSessionUrl", () => {
  test("会話 URL から origin / sessionId / spaceId を取り出す", () => {
    expect(parseSessionUrl("https://agent.example.com/s/0123456789?space=space-0123456789abcdef")).toEqual({
      origin: "https://agent.example.com",
      sessionId: "0123456789",
      spaceId: "space-0123456789abcdef",
    });
  });

  test("space の省略は default", () => {
    expect(parseSessionUrl("https://agent.example.com/s/0123456789")).toEqual({
      origin: "https://agent.example.com",
      sessionId: "0123456789",
      spaceId: "default",
    });
  });

  test("https 以外・資格情報付き・会話でないパスを拒否する", () => {
    for (const value of [
      "http://agent.example.com/s/0123456789",
      "https://user:pass@agent.example.com/s/0123456789",
      "https://agent.example.com/api/sessions/0123456789",
      "https://agent.example.com/s/012345678",
      "https://agent.example.com/s/zzzzzzzzzz",
      "https://agent.example.com/s/0123456789?space=space-xyz",
      "not a url",
    ]) {
      expect(() => parseSessionUrl(value)).toThrow(AdminError);
    }
  });
});

describe("parseOrigin", () => {
  test("パスを持たない https の origin を受け付ける", () => {
    expect(parseOrigin("https://agent.example.com")).toBe("https://agent.example.com");
    expect(parseOrigin("https://agent.example.com/")).toBe("https://agent.example.com");
  });

  test("パス・資格情報・その他の scheme を拒否する", () => {
    for (const value of [
      "https://agent.example.com/app",
      "http://agent.example.com",
      "ftp://agent.example.com",
      "https://a:b@agent.example.com",
    ]) {
      expect(() => parseOrigin(value)).toThrow(AdminError);
    }
  });
});

describe("parseSpaceId", () => {
  test("空は default、それ以外は形式を検証する", () => {
    expect(parseSpaceId("")).toBe("default");
    expect(parseSpaceId("space-0123456789abcdef")).toBe("space-0123456789abcdef");
    expect(() => parseSpaceId("space-x")).toThrow(AdminError);
  });
});

describe("sessionUrls", () => {
  test("会話 URL と API の URL を組み立てる", () => {
    const urls = sessionUrls({ origin: "https://agent.example.com", sessionId: "0123456789", spaceId: "default" });

    expect(urls.sessionUrl).toBe("https://agent.example.com/s/0123456789?space=default");
    expect(urls.sessionApi).toBe("https://agent.example.com/api/sessions/0123456789?spaceId=default");
    expect(urls.messagesApi).toBe("https://agent.example.com/api/sessions/0123456789/messages?spaceId=default");
    expect(safeSessionUrl("https://agent.example.com", "0123456789", "default")).toBe(urls.sessionUrl);
  });

  test("保存値が壊れていればリンクを作らない", () => {
    expect(safeSessionUrl("not a url", "0123456789", "default")).toBeNull();
  });
});

describe("fileUrls", () => {
  test("root 相対の path をファイル API の URL へ組み立てる", () => {
    const urls = fileUrls(
      { origin: "https://agent.example.com", sessionId: "0123456789", spaceId: "default" },
      "projects/app/generated/cafe image.png",
    );

    expect(urls.statApi).toBe(
      "https://agent.example.com/api/files/stat?path=projects%2Fapp%2Fgenerated%2Fcafe%20image.png",
    );
    expect(urls.rawApi).toBe(
      "https://agent.example.com/api/files/raw?path=projects%2Fapp%2Fgenerated%2Fcafe%20image.png",
    );
    expect(urls.downloadApi).toBe(
      "https://agent.example.com/api/files/download?path=projects%2Fapp%2Fgenerated%2Fcafe%20image.png",
    );
  });
});
