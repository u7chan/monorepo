import { describe, test, expect } from "bun:test";
import { getHelloMessage, getGoodnightMessage } from "../src/index";

describe("demo-greeting-lib", () => {
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
