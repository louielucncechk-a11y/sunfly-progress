const assert = require("node:assert/strict");
const path = require("node:path");
const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" });
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
  await browser.close();
  console.log("界面测试通过：总览、10项数据、内部测试、两轮历史与只读保护均正常。");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
