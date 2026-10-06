import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const temporary = await mkdtemp(path.join(tmpdir(), "sycm-empty-test-"));
let child;
try {
  for (const file of ["server.mjs", "business-analysis.mjs", "diagnosis-center.mjs", "operations-store.mjs", "public", "scripts"]) {
    await cp(path.join(root, file), path.join(temporary, file), { recursive: true });
  }
  child = spawn(process.execPath, ["server.mjs"], {
    cwd: temporary, env: { ...process.env, PORT: "0" }, windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const base = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("服务启动超时")), 15000);
    child.once("error", reject);
    child.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`服务提前退出: ${code}`)); });
    child.stdout.on("data", (chunk) => {
      const match = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timeout); resolve(match[0]); }
    });
  });
  for (const page of ["/", "/transaction.html", "/traffic.html", "/customer.html", "/diagnosis.html", "/actions.html", "/audit.html", "/system.html"]) {
    assert.equal((await fetch(base + page)).status, 200, page);
  }
  for (const endpoint of ["/api/homepage", "/api/diagnosis", "/api/module/transaction", "/api/module/traffic", "/api/module/customer"]) {
    const response = await fetch(base + endpoint);
    assert.equal(response.status, 200, endpoint);
    assert.equal((await response.json()).status, "waiting", endpoint);
  }
  const audit = await fetch(base + "/api/audit").then((r) => r.json());
  assert.equal(audit.summary.totalFiles, 0);
  assert.equal(audit.summary.moduleCount, 10);
  const actions = await fetch(base + "/api/actions").then((r) => r.json());
  assert.deepEqual(actions.actions, []);
  assert.equal((await fetch(base + "/api/system")).status, 200);
  console.log("PASS: 无数据首次启动、8 个页面、等待接口、空行动与系统检查。");
} finally {
  if (child && child.exitCode === null) {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill();
    await exited;
  }
  // Only remove the validated test-owned directory created by mkdtemp.
  if (path.dirname(temporary) !== tmpdir() || !path.basename(temporary).startsWith("sycm-empty-test-")) throw new Error("临时路径校验失败");
  await rm(temporary, { recursive: true, force: true });
}
