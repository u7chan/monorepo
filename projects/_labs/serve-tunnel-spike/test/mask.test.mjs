import assert from "node:assert/strict";
import test from "node:test";
import { sanitize } from "../src/report.mjs";
import { mask } from "../src/tunnel.mjs";

test("masks tunnel hostnames and IP addresses", () => {
  assert.equal(mask("https://example.trycloudflare.com/path"), "https://<random>.trycloudflare.com/path");
  assert.equal(mask("10.20.30.40"), "<ip>");
  assert.equal(mask("2001:db8::"), "<ipv6>");
  assert.equal(mask("2001:db8:::"), "<ipv6>:");
  assert.equal(mask("2001:db8::1"), "<ipv6>");
  assert.equal(mask("::1"), "<ipv6>");
  assert.equal(mask("fe80::1234:5678:9abc:def0"), "<ipv6>");
  assert.equal(mask("2001:db8::1234:192.0.2.9"), "<ipv6>");
  assert.equal(mask("2001:db8::192.0.2.9"), "<ipv6>");
  assert.equal(mask("::ffff:192.0.2.1"), "<ipv6>");
  assert.equal(mask("[2001:db8::1]:443"), "[<ipv6>]:443");
});

test("keeps loopback addresses and timestamps", () => {
  assert.equal(mask("http://127.0.0.1:8080/"), "http://127.0.0.1:8080/");
  assert.equal(mask("2026-11-28T03:47:36Z"), "2026-11-28T03:47:36Z");
  assert.equal(mask("aa:bb:cc:dd:ee:ff"), "aa:bb:cc:dd:ee:ff");
  assert.equal(mask("foo::: bar"), "foo::: bar");
});

test("sanitize masks nested report values", () => {
  assert.deepEqual(sanitize({ url: "https://example.trycloudflare.com/", list: ["2001:db8::", "2001:db8::1234:192.0.2.9"] }), {
    url: "https://<random>.trycloudflare.com/",
    list: ["<ipv6>", "<ipv6>"],
  });
});
