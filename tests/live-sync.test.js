const assert = require("node:assert/strict");
const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  });
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  const pages = await Promise.all(contexts.map((context) => context.newPage()));
  const errors = [];
  pages.forEach((page, index) => {
    page.on("pageerror", (error) => errors.push(`设备${index + 1}: ${error.message}`));
    page.on("console", (message) => { if (message.type() === "error") errors.push(`设备${index + 1}: ${message.text()}`); });
  });

  await Promise.all(pages.map((page) => page.goto("http://progress.sunfly.hk", { waitUntil: "networkidle" })));
  for (const page of pages) {
    assert.equal(await page.locator("#projectRows tr").count(), 10, "每台设备都应读取 10 个云端项目");
    assert.match(await page.locator("#saveState").innerText(), /云端已同步/);
  }
  const names = await Promise.all(pages.map((page) => page.locator("#projectRows tr .project-name").first().innerText()));
  assert.equal(names[0], names[1], "两台设备读取的数据应一致");
  assert.deepEqual(errors, [], `正式网站不应出现错误：${errors.join(" | ")}`);

  await browser.close();
  console.log("正式网站验证通过：两台独立设备均读取到 10 个项目，状态为云端已同步。");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
