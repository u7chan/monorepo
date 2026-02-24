import { describe, test, expect } from "bun:test";
import { getHelloMessage, getGoodnightMessage } from "../src/index";

describe("example-lib-a", () => {
  describe("getHelloMessage", () => {
    test("正しい挨拶メッセージを返す", () => {
      expect(getHelloMessage()).toBe("Hello😊");
    });
  });

  describe("getGoodnightMessage", () => {
    test("正しいおやすみメッセージを返す", () => {
      expect(getGoodnightMessage()).toBe("Good night🌙");
    });
  });
});
