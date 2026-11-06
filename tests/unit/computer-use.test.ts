/**
 * Computer Use sidecar 管理器（services/computerUse.ts）单元测试
 *
 * 运行方式：node server/node_modules/tsx/dist/cli.mjs tests/unit/computer-use.test.ts
 * （被测模块为纯 Node 实现，不依赖 electron；spawn/fetch/设置/token/时钟全部经 deps 注入 mock）
 *
 * 覆盖：命令解析优先级（env 覆盖 > resources exe > dev fallback > 未安装）→ 懒启动 →
 * token/大脑 env 注入 → 端口冲突递增重试 → health 超时（假时钟快进）→
 * not_installed 优雅降级 → stopSidecar 清理与重启 → 任务/回放请求映射与鉴权头 →
 * 并发启动单飞。
 */

import assert from 'node:assert/strict';
import {
  __resetComputerUseForTest,
  getSidecarStatus,
  getSidecarState,
  getTaskStatus,
  playScript,
  resolveSidecarCommand,
  runTask,
  splitCommandLine,
  stopSidecar,
  stopTask,
} from '../../src/main/services/computerUse.ts';
import type {ComputeUseChild, ComputeUseDeps, ComputeUseSpawnOptions} from '../../src/main/services/computerUse.ts';

const TEST_TOKEN = 'cu-test-token-0123456789abcdef';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

// ====== fake 子进程 ======

class FakeChild implements ComputeUseChild {
  static seq = 0;
  pid = 1000 + FakeChild.seq++;
  exitCode: number | null = null;
  killed = false;
  private cbs: ((code: number | null) => void)[] = [];
  onExit(cb: (code: number | null) => void): void {
    if (this.exitCode !== null) cb(this.exitCode);
    else this.cbs.push(cb);
  }
  exit(code: number | null): void {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    for (const cb of this.cbs.splice(0)) cb(code);
  }
  kill(): void {
    this.killed = true;
    this.exit(-1);
  }
}

// ====== mock deps ======

interface SpawnRecord {
  cmd: string;
  args: string[];
  opts: ComputeUseSpawnOptions;
  child: FakeChild;
}
interface FetchRecord {
  url: string;
  init?: {method?: string; headers?: Record<string, string>; body?: string};
}

interface MockOpts {
  /** spawn 出来的子进程行为：'healthy' 正常就绪 / 'exitImmediately' 秒退（端口冲突） / 'neverHealthy' 僵死 */
  childBehavior?: 'healthy' | 'exitImmediately' | 'neverHealthy';
  /** 健康检查通过前让前 N 次 spawn 秒退（端口冲突重试用） */
  exitTimes?: number;
  commandOverride?: string;
  fileExists?: (p: string) => boolean;
  resourcesDir?: string;
  devPythonPath?: string;
  /** 健康检查闸门：true 才放行（并发单飞测试用） */
  healthGate?: {open: boolean};
  /** 假时钟（health 超时快进）；不传用真实时钟 */
  fakeClock?: boolean;
}

const makeDeps = (opts: MockOpts = {}) => {
  const spawned: SpawnRecord[] = [];
  const fetches: FetchRecord[] = [];
  let nowVal = 0;
  const exitTimes = opts.exitTimes ?? 0;

  const deps: ComputeUseDeps = {
    spawn: (cmd, args, o) => {
      const child = new FakeChild();
      spawned.push({cmd, args, opts: o, child});
      const behavior = spawned.length <= exitTimes ? 'exitImmediately' : (opts.childBehavior ?? 'healthy');
      if (behavior === 'exitImmediately') {
        // 同步秒退（模拟端口被占/EADDRINUSE）：spawn 返回时 exitCode 已置位，
        // 早于 health 轮询首个检查，避免与「端口上已有健康实例」竞态
        child.exit(1);
      }
      return child;
    },
    fetch: async (url, init) => {
      fetches.push({url, init});
      if (url.endsWith('/health')) {
        if (opts.healthGate && !opts.healthGate.open) throw new Error('connect ECONNREFUSED');
        if ((opts.childBehavior ?? 'healthy') === 'neverHealthy') return {status: 503, json: async () => ({status: 'starting'})};
        return {status: 200, json: async () => ({status: 'ok'})};
      }
      if (url.endsWith('/tasks') && init?.method === 'POST') {
        return {status: 202, json: async () => ({task_id: 'task0001'})};
      }
      if (/\/tasks\/([^/]+)$/.test(url)) {
        const tid = url.match(/\/tasks\/([^/]+)$/)![1];
        if (tid === 'missing') return {status: 200, json: async () => ({error: 'not found'})};
        return {status: 200, json: async () => ({status: 'done', success: true, result: {steps: 3}, task: '演示任务'})};
      }
      if (/\/tasks\/([^/]+)\/stop$/.test(url)) {
        return {status: 200, json: async () => ({stopping: true})};
      }
      if (url.endsWith('/replay') && init?.method === 'POST') {
        return {status: 202, json: async () => ({task_id: 'replay01'})};
      }
      return {status: 404, json: async () => ({error: 'no route'})};
    },
    fileExists: opts.fileExists ?? (() => true),
    getCommandOverride: () => opts.commandOverride ?? '"C:\\cu dir\\python.exe" -m compute_use.server.api',
    getResourcesDir: () => opts.resourcesDir ?? 'C:\\app\\resources',
    ...(opts.devPythonPath ? {getDevPythonPath: () => opts.devPythonPath!} : {}),
    getBrainConfig: () => ({baseUrl: 'https://brain.example.com/v1', model: 'glm-4.6v-flash', apiKey: 'brain-key'}),
    ensureToken: () => TEST_TOKEN,
    ...(opts.fakeClock
      ? {now: () => nowVal, sleep: async (ms: number) => { nowVal += ms; }}
      : {}),
    log: () => {},
  };
  return {deps, spawned, fetches, advanceClock: (ms: number) => { nowVal += ms; }};
};

// ====== 测试主体 ======

const main = async () => {
  // (a) 命令行切分
  console.log('命令行切分:');
  {
    assert.deepEqual(splitCommandLine('"C:\\my dir\\py.exe" -m foo --bar'), ['C:\\my dir\\py.exe', '-m', 'foo', '--bar']);
    assert.deepEqual(splitCommandLine('C:\\py.exe -m foo'), ['C:\\py.exe', '-m', 'foo']);
    assert.deepEqual(splitCommandLine(''), []);
    ok('splitCommandLine 支持双引号路径与裸命令');
  }

  // (b) 路径解析优先级
  console.log('命令解析优先级:');
  {
    __resetComputerUseForTest();
    const exists = (p: string) => p.includes('compute-use-server.exe') || p.includes('python');
    // env 覆盖最优先
    const c1 = resolveSidecarCommand({getCommandOverride: () => '"D:\\x\\server.exe" --flag', getResourcesDir: () => 'R', fileExists: exists});
    assert.deepEqual(c1, {cmd: 'D:\\x\\server.exe', args: ['--flag'], origin: 'override'});
    ok('env PIANYU_COMPUTE_USE_CMD 完整命令覆盖最优先');
    // resources exe 其次
    const c2 = resolveSidecarCommand({getCommandOverride: () => '', getResourcesDir: () => 'R', fileExists: exists});
    assert.equal(c2?.origin, 'resources');
    assert.ok(c2?.cmd.endsWith('compute-use-server.exe'));
    ok('resources 目录 exe 次之');
    // dev fallback：exe 不存在但 python 在
    const c3 = resolveSidecarCommand({getCommandOverride: () => '', getResourcesDir: () => 'R', fileExists: (p) => p.includes('python'), getDevPythonPath: () => 'D:\\compute_use\\.venv\\Scripts\\python.exe'});
    assert.equal(c3?.origin, 'dev');
    assert.deepEqual(c3?.args, ['-m', 'compute_use.server.api']);
    assert.equal(c3?.cwd, 'D:\\compute_use');
    ok('dev fallback：python -m compute_use.server.api，cwd 为脚手架根目录');
    // 全部缺失 → not_installed
    const c4 = resolveSidecarCommand({getCommandOverride: () => '', getResourcesDir: () => 'R', fileExists: () => false, getDevPythonPath: () => 'N:\\none\\python.exe'});
    assert.equal(c4, null);
    ok('全部缺失返回 null（not_installed 降级）');
  }

  // (c) 懒启动 + env 注入 + 任务请求映射
  console.log('懒启动 / env 注入 / 请求映射:');
  {
    __resetComputerUseForTest();
    const {deps, spawned, fetches} = makeDeps();
    // 懒启动：查询状态不拉起进程
    const s0 = getSidecarStatus(deps);
    assert.equal(s0.status, 'stopped');
    assert.equal(spawned.length, 0, '状态查询不应拉起 sidecar');
    ok('懒启动：无工具调用时 spawn 不发生');

    const r = await runTask(deps, {task: '打开资源管理器', maxSteps: 10, filmMode: true});
    assert.ok(r.ok, `runTask 应成功：${!r.ok ? r.message : ''}`);
    if (r.ok) {
      assert.equal(r.data.taskId, 'task0001');
      assert.equal(r.data.port, 8765);
    }
    assert.equal(spawned.length, 1, '首次调用应拉起一次 sidecar');
    const sp = spawned[0];
    assert.equal(sp.cmd, 'C:\\cu dir\\python.exe', 'env 覆盖命令应解析出引号内路径');
    assert.deepEqual(sp.args, ['-m', 'compute_use.server.api']);
    // env 注入：token + 端口 + 大脑三件套
    assert.equal(sp.opts.env.COMPUTE_USE_TOKEN, TEST_TOKEN);
    assert.equal(sp.opts.env.COMPUTE_USE_PORT, '8765');
    assert.equal(sp.opts.env.COMPUTE_USE_MODEL, 'glm-4.6v-flash');
    assert.equal(sp.opts.env.COMPUTE_USE_BASE_URL, 'https://brain.example.com/v1');
    assert.equal(sp.opts.env.COMPUTE_USE_API_KEY, 'brain-key');
    ok('spawn 注入 COMPUTE_USE_TOKEN/PORT/MODEL/BASE_URL/API_KEY');
    // /health 就绪探针不带鉴权；/tasks 带 Bearer
    const healthCall = fetches.find((f) => f.url.endsWith('/health'))!;
    assert.equal(healthCall.url, 'http://127.0.0.1:8765/health');
    assert.equal(healthCall.init?.headers?.Authorization, undefined, 'health 探针不带鉴权头');
    const taskCall = fetches.find((f) => f.url.endsWith('/tasks'))!;
    assert.equal(taskCall.init?.method, 'POST');
    assert.equal(taskCall.init?.headers?.Authorization, `Bearer ${TEST_TOKEN}`);
    assert.deepEqual(JSON.parse(taskCall.init!.body!), {task: '打开资源管理器', max_steps: 10, film_mode: true, dry_run: false});
    ok('POST /tasks 带 Bearer token，camelCase→snake_case 映射正确');

    // 已运行时再次调用不重复拉起
    const r2 = await runTask(deps, {task: '再做一个任务'});
    assert.ok(r2.ok);
    assert.equal(spawned.length, 1, 'sidecar 已运行时不应重复 spawn');
    ok('幂等：运行中复用同一 sidecar 实例');
  }

  // (d) 端口冲突递增重试
  console.log('端口冲突重试:');
  {
    __resetComputerUseForTest();
    const {deps, spawned} = makeDeps({exitTimes: 2});
    const r = await runTask(deps, {task: 't'});
    assert.ok(r.ok, `两次端口冲突后应成功：${!r.ok ? r.message : ''}`);
    if (r.ok) assert.equal(r.data.port, 8767);
    assert.equal(spawned.length, 3);
    assert.equal(spawned[0].opts.env.COMPUTE_USE_PORT, '8765');
    assert.equal(spawned[1].opts.env.COMPUTE_USE_PORT, '8766');
    assert.equal(spawned[2].opts.env.COMPUTE_USE_PORT, '8767');
    ok('前两个端口秒退 → 递增到 8767 成功');
  }

  // (e) health 超时（假时钟快进）
  console.log('health 超时:');
  {
    __resetComputerUseForTest();
    const {deps, spawned} = makeDeps({childBehavior: 'neverHealthy', fakeClock: true});
    const r = await runTask(deps, {task: 't'});
    assert.ok(!r.ok);
    if (!r.ok) {
      assert.equal(r.code, 'start_timeout');
      assert.match(r.message, /超时/);
    }
    assert.equal(spawned.length, 1, '超时不是端口问题，不应换端口重试');
    assert.equal(spawned[0].child.killed, true, '超时后应杀掉僵死进程');
    assert.equal(getSidecarState().status, 'stopped');
    ok('30s health 超时 → start_timeout + 杀进程 + 状态复位');
  }

  // (f) not_installed 优雅降级
  console.log('not_installed 降级:');
  {
    __resetComputerUseForTest();
    const {deps, spawned} = makeDeps({commandOverride: '', fileExists: () => false, devPythonPath: 'N:\\none\\python.exe'});
    const r = await runTask(deps, {task: 't'});
    assert.ok(!r.ok);
    if (!r.ok) {
      assert.equal(r.code, 'not_installed');
      assert.match(r.message, /未安装/);
    }
    assert.equal(spawned.length, 0, '未安装不应尝试 spawn');
    const s = getSidecarStatus(deps);
    assert.equal(s.status, 'not_installed');
    assert.ok(s.detail && s.detail.length > 0);
    ok('引擎缺失 → not_installed + 中文指引，不 spawn');
  }

  // (g) stopSidecar 清理与重启
  console.log('stopSidecar 清理:');
  {
    __resetComputerUseForTest();
    const {deps, spawned} = makeDeps();
    const r1 = await runTask(deps, {task: 't'});
    assert.ok(r1.ok);
    stopSidecar();
    assert.equal(spawned[0].child.killed, true, 'stopSidecar 应杀掉子进程');
    assert.equal(getSidecarState().status, 'stopped');
    assert.equal(getSidecarState().port, 0);
    // 停止后再次调用可重新拉起（懒启动语义恢复）
    const r2 = await runTask(deps, {task: 't2'});
    assert.ok(r2.ok);
    assert.equal(spawned.length, 2, '停止后可重新拉起新实例');
    ok('stopSidecar 杀进程 + 复位，下次调用重新懒启动');
  }

  // (h) 任务状态 / 停止 / 回放请求映射
  console.log('状态/停止/回放映射:');
  {
    __resetComputerUseForTest();
    const {deps, fetches} = makeDeps();
    const st = await getTaskStatus(deps, 'task0001');
    assert.ok(st.ok);
    if (st.ok) {
      assert.equal(st.data.status, 'done');
      assert.equal(st.data.success, true);
      assert.deepEqual(st.data.result, {steps: 3});
      assert.equal(st.data.task, '演示任务');
    }
    const statusCall = fetches.find((f) => /\/tasks\/task0001$/.test(f.url))!;
    assert.equal(statusCall.init?.headers?.Authorization, `Bearer ${TEST_TOKEN}`);
    ok('GET /tasks/{tid} 映射为 ComputerTaskStatus（带鉴权）');

    const missing = await getTaskStatus(deps, 'missing');
    assert.ok(!missing.ok);
    if (!missing.ok) assert.equal(missing.code, 'not_found');
    ok('未知 taskId（sidecar 200 + error）映射为 not_found');

    const sp = await stopTask(deps, 'task0001');
    assert.ok(sp.ok);
    if (sp.ok) assert.equal(sp.data.stopping, true);
    const stopCall = fetches.find((f) => /\/tasks\/task0001\/stop$/.test(f.url))!;
    assert.equal(stopCall.init?.method, 'POST');
    ok('POST /tasks/{tid}/stop 返回 {stopping}');

    const rp = await playScript(deps, {scriptPath: 'D:\\runs\\s1\\script.jsonl'});
    assert.ok(rp.ok);
    if (rp.ok) assert.equal(rp.data.taskId, 'replay01');
    const replayCall = fetches.find((f) => f.url.endsWith('/replay'))!;
    assert.deepEqual(JSON.parse(replayCall.init!.body!), {script_path: 'D:\\runs\\s1\\script.jsonl', verify: true, film_mode: false});
    ok('POST /replay 映射 verify 缺省 true + snake_case');
  }

  // (i) 并发启动单飞
  console.log('并发单飞:');
  {
    __resetComputerUseForTest();
    const gate = {open: false};
    const {deps, spawned} = makeDeps({healthGate: gate});
    const p1 = runTask(deps, {task: 'a'});
    const p2 = runTask(deps, {task: 'b'});
    // 两个调用都卡在 health 闸门后放行
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(getSidecarState().status, 'starting', '已 spawn 未就绪的窗口期应报 starting（而非 running/port 0）');
    gate.open = true;
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.ok(r1.ok && r2.ok);
    assert.equal(spawned.length, 1, '并发调用应共享同一次启动');
    assert.equal(getSidecarState().status, 'running');
    assert.ok(getSidecarState().port > 0);
    ok('并发 runTask 只拉起一个 sidecar（starting 单飞 + 窗口期状态正确）');
  }

  console.log(`\n===== ${passed} 项全部通过 =====`);
};

main().catch((err) => {
  console.error('\n✗ 测试失败：', err);
  process.exit(1);
});
