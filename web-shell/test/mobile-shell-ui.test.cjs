const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "..", "..");
const htmlPath = path.join(repoRoot, "web-shell", "mobile.html");
const cssPath = path.join(repoRoot, "web-shell", "mobile.css");

test("mobile shell keeps an official-like compact application frame", () => {
  const html = fs.readFileSync(htmlPath, "utf8");
  const css = fs.readFileSync(cssPath, "utf8");

  assert.match(html, /<main class="mobile-shell" aria-label="OpenCodex 移动端">/);
  assert.match(html, /<header class="topbar" aria-label="当前会话状态">/);
  assert.match(html, /<section class="summary" aria-label="轻量同步状态">/);
  assert.match(html, /class="full-mode" href="\/">完整 Codex<\/a>/);
  assert.match(css, /--surface: #f7f7f8/);
  assert.match(css, /--panel: #ffffff/);
  assert.match(css, /--signal: #10a37f/);
  assert.match(css, /\.mobile-shell \{[^}]*max-width: 840px/s);
  assert.match(css, /\.mobile-shell > \* \{[^}]*min-width: 0/s);
  assert.match(css, /\.topbar \{[^}]*position: sticky/s);
  assert.match(css, /\.topbar > div \{[^}]*min-width: 0/s);
  assert.match(css, /\.topbar,\n\.summary,\n\.thread-list,\n\.thread-card,\n\.message-list \{[^}]*border-radius: 8px/s);
  assert.match(css, /\.summary \{[^}]*min-width: 0/s);
  assert.match(css, /\.thread-list \{[^}]*min-width: 0/s);
  assert.match(css, /\.message-list \{[^}]*min-width: 0/s);
  assert.match(css, /\.thread-card \{[^}]*min-width: 0/s);
  assert.match(css, /\.thread-card \{[^}]*overflow: hidden/s);
  assert.match(css, /\.message \{[^}]*min-width: 0/s);
  assert.doesNotMatch(css, /box-shadow:/);
  assert.match(css, /\.summary \{[^}]*border-radius: 8px/s);
});
