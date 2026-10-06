import { promises as fs } from "node:fs";
import path from "node:path";

const VALID_STATUS = new Set(["待处理", "执行中", "待验证", "已完成", "验证有效", "验证无效", "已搁置", "待配置"]);

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(filePath, value) {
  const temporary = `${filePath}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value, null, 2), "utf8");
  await fs.rename(temporary, filePath);
}

export class OperationsStore {
  constructor(rootDir) {
    this.exportDir = path.join(rootDir, "action_exports");
    this.statePath = path.join(this.exportDir, "action_state.json");
    this.executionPath = path.join(this.exportDir, "execution_tasks.json");
    this.todayPath = path.join(this.exportDir, "today_actions.json");
    this.historyPath = path.join(this.exportDir, "action_history.jsonl");
    this.writeQueue = Promise.resolve();
  }

  runExclusive(operation) {
    const queued = this.writeQueue.then(operation, operation);
    this.writeQueue = queued.catch(() => {});
    return queued;
  }

  async initialize() {
    await fs.mkdir(this.exportDir, { recursive: true });
  }

  async readState() {
    await this.initialize();
    return readJson(this.statePath, { updated_at: null, actions: {} });
  }

  async list() {
    await this.initialize();
    const execution = await readJson(this.executionPath, { generated_at: null, source: "生意参谋数据工作台", actions: [] });
    return execution;
  }

  async mergeGenerated(generatedActions) {
    return this.runExclusive(async () => {
      await this.initialize();
      const state = await this.readState();
      const generatedAt = new Date().toISOString();
      const actions = generatedActions.map((action) => {
        const saved = state.actions[action.id] || {};
        return {
          ...action,
          status: saved.status || action.status,
          owner: saved.owner || "",
          due_date: saved.due_date || "",
          note: saved.note || "",
          verification: saved.verification || "",
          updated_at: saved.updated_at || null,
          generated_at: generatedAt
        };
      });
      await this.writeExports(actions, generatedAt);
      return { generated_at: generatedAt, source: "生意参谋数据工作台", actions };
    });
  }

  async writeExports(actions, generatedAt = new Date().toISOString()) {
    const activeStatuses = new Set(["待处理", "执行中", "待验证", "待配置"]);
    const today = actions.filter((action) => action.priority === "高" && activeStatuses.has(action.status)).slice(0, 5)
      .map((action) => ({ ...action, sync_target: "今日待办" }));
    await Promise.all([
      writeJsonAtomic(this.executionPath, { generated_at: generatedAt, source: "生意参谋数据工作台", actions }),
      writeJsonAtomic(this.todayPath, { generated_at: generatedAt, source: "生意参谋数据工作台", actions: today })
    ]);
  }

  async update(id, patch) {
    return this.runExclusive(async () => {
      const allowed = {};
      if (patch.status != null) {
        if (!VALID_STATUS.has(patch.status)) throw new Error("不支持的行动状态");
        allowed.status = patch.status;
      }
      for (const key of ["owner", "due_date", "note", "verification"]) {
        if (patch[key] != null) allowed[key] = String(patch[key]).trim().slice(0, key === "note" || key === "verification" ? 500 : 80);
      }
      if (allowed.due_date && !/^\d{4}-\d{2}-\d{2}$/.test(allowed.due_date)) throw new Error("截止日期格式必须为 YYYY-MM-DD");

      const current = await this.list();
      const existing = current.actions.find((action) => action.id === id);
      if (!existing) throw new Error("行动项不存在或已不在当前诊断周期");
      const updatedAt = new Date().toISOString();
      const updated = { ...existing, ...allowed, updated_at: updatedAt };
      const actions = current.actions.map((action) => action.id === id ? updated : action);
      const state = await this.readState();
      state.updated_at = updatedAt;
      state.actions[id] = {
        status: updated.status,
        owner: updated.owner,
        due_date: updated.due_date,
        note: updated.note,
        verification: updated.verification,
        updated_at: updatedAt
      };
      await Promise.all([
        writeJsonAtomic(this.statePath, state),
        this.writeExports(actions, current.generated_at || updatedAt),
        fs.appendFile(this.historyPath, `${JSON.stringify({ action_id: id, title: updated.title, changes: allowed, updated_at: updatedAt })}\n`, "utf8")
      ]);
      return updated;
    });
  }
}

export async function readRequestJson(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("请求内容过大");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
