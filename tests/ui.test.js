const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    args: ["--host-resolver-rules=MAP progress.sunfly.hk 127.0.0.1"],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("http://127.0.0.1:8765", { waitUntil: "networkidle" });
  await page.screenshot({ path: path.join(__dirname, "overview.png"), fullPage: true });
  assert.equal(await page.locator("#projectRows tr").count(), 10, "总览应显示 10 个项目");
  assert.match(await page.locator("body").innerText(), /内部测试/);
  assert.match(await page.locator("body").innerText(), /progress\.sunfly\.hk/);

  const targetRow = page.locator("#projectRows tr", { hasText: "燃烧性能分级" });
  await targetRow.getByRole("button", { name: /查看/ }).click();
  await page.locator("#detailDrawer.open").waitFor();
  assert.equal(await page.locator("#roundSelect option").count(), 2, "EN 13501-1 应显示两轮历史");
  assert.match(await page.locator("#roundForm").innerText(), /内部测试状态/);
  await page.locator("#roundSelect").selectOption("0");
  assert.equal(await page.locator('#roundForm button[type="submit"]').isDisabled(), true, "历史轮次应只读");
  await page.screenshot({ path: path.join(__dirname, "detail.png"), fullPage: true });

  assert.deepEqual(errors, [], `页面不应出现错误：${errors.join(" | ")}`);

  const staticPage = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  let putRequests = 0;
  const fixture = fs.readFileSync(path.join(__dirname, "..", "data", "tracker-data.json"), "utf8");
  await staticPage.route("https://sunfly-progress-sync.luyinyu1998.workers.dev/api/data", async (route) => {
    if (route.request().method() === "PUT") {
      putRequests += 1;
      await route.fulfill({ status: 200, contentType: "application/json", headers: { ETag: '"rev-2"' }, body: '{"ok":true,"revision":2}' });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", headers: { ETag: '"rev-1"' }, body: fixture });
  });
  await staticPage.goto("http://progress.sunfly.hk:8765", { waitUntil: "networkidle" });
  await staticPage.locator("#projectRows tr").first().getByRole("button", { name: /查看/ }).click();
  await staticPage.locator('#roundForm button[type="submit"]').click();
  await staticPage.locator("#toast.show").waitFor();
  assert.match(await staticPage.locator("#toast").innerText(), /本轮进度已保存/);
  assert.equal(putRequests, 1, "静态站点应向云端发送一次 PUT 请求");
  assert.match(await staticPage.locator("#saveState").innerText(), /云端已同步/);

  await browser.close();
  console.log("界面测试通过：总览、10项数据、内部测试、两轮历史、只读保护与云端保存均正常。");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
