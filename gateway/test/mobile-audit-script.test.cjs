const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "..", "..");
const scriptPath = path.join(repoRoot, "scripts", "audit-mobile-lite.cjs");
const packagePath = path.join(repoRoot, "package.json");

test("mobile audit script documents the phone traffic budget checks", () => {
  const source = fs.readFileSync(scriptPath, "utf8");
  const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));

  assert.equal(pkg.scripts["mobile:audit"], "node scripts/audit-mobile-lite.cjs");
  assert.match(pkg.scripts.test, /mobile-audit-script\.test\.cjs/);
  assert.match(source, /OPENCODEX_MOBILE_AUDIT_BASE_URL/);
  assert.match(source, /OPENCODEX_MOBILE_AUDIT_THREAD_ID/);
  assert.match(source, /MOBILE_AUDIT_USER_AGENT/);
  assert.match(source, /function rendererHandoffPath/);
  assert.match(source, /__opencodex_renderer/);
  assert.match(source, /entry-shell/);
  assert.match(source, /renderer/);
  assert.match(source, /mobileTrafficMode/);
  assert.match(source, /\/api\/mobile\/bootstrap\?limit=/);
  assert.match(source, /\/api\/mobile\/thread\/\$\{encodeURIComponent\(threadId\)\}\?limit=/);
  assert.match(source, /if-none-match/);
  assert.match(source, /status === 304/);
  assert.match(source, /durationMs/);
  assert.match(source, /bodyBytes/);
  assert.match(source, /estimatedPayloadBytes/);
  assert.match(source, /Mobile official-shell audit/);
});
