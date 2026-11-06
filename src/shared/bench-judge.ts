/**
 * 时间线操作 bench 判分器（timeline-master-plan M3 验收：「时间线操作 bench」首批可判分任务）
 *
 * 定位：finish-task 式硬门——模型按任务指令在 agent 工具面执行 L1/L2 操作，判分器对
 * **终态**做声明式断言（不评轨迹过程；过程自由度是产品卖点）。这是 omni 不走片语 bench
 * 的破局点：状态断言确定性可判，不需要渲染对拍（渲染 diff 留给需要视觉门的任务后续扩展）。
 *
 * 契约（纯函数，Node 可直跑单测；runner = scripts/bench-timeline-ops.ts）：
 * - 任务 = {fixture 初始工程态, prompt 指令, allowedTools 面, judge 断言, refTrajectory 参考轨迹}
 * - 断言三型：`eq`（深等）| `about`（数值容差）| `len`（数组长度）；`unchanged` = 与 fixture
 *   逐路径比对（防「顺手改坏别的」）；`forbiddenCalls` = 轨迹禁用工具（面纪律）。
 * - 判分器对「正确轨迹全过 / 错误轨迹必挂」都要成立（selftest 证明可判分——判分器本身可判分）。
 */

export interface BenchJudgeAssertion {
  /** 状态路径（段内下标语义，如 "segments[0].beats"） */
  path: string;
  /** 深等断言（缺省 undefined 也算值——「键消失」可判） */
  eq?: unknown;
  /** 数值容差断言（与 eq 二选一） */
  about?: number;
  tol?: number;
  /** 数组长度断言 */
  len?: number;
  /** 键消失断言（getPath 为 undefined 才过——清除类任务） */
  absent?: boolean;
}

export interface BenchTask {
  id: string;
  title: string;
  /** 给模型的指令（自然语言） */
  prompt: string;
  /** 初始工程态（注入 store 的最小片段集；segments/bgm/sfx 同 store 形状） */
  fixture: {
    segments: unknown[];
    bgm?: unknown | null;
    sfx?: unknown;
  };
  /** 允许的 agent 工具面（越界调用记违规；'*' = 全量） */
  allowedTools?: string[];
  judge: {
    assert: BenchJudgeAssertion[];
    /** 不得偏离 fixture 的路径（防顺手改坏） */
    unchanged?: string[];
    /** 轨迹中禁用的工具（面纪律判分） */
    forbiddenCalls?: string[];
  };
  /** 参考轨迹（正确解；selftest 用） */
  refTrajectory: Array<{tool: string; args: Record<string, unknown>}>;
  /** 错误轨迹（判分器必须抓住；selftest 用——判分器本身可判分的证明） */
  badTrajectory?: Array<{tool: string; args: Record<string, unknown>}>;
}

export interface BenchJudgeFailure {
  path: string;
  kind: 'eq' | 'about' | 'len' | 'unchanged' | 'forbidden';
  got: unknown;
  want: unknown;
}

/** 点路径取值："segments[0].beats[1].t" / "bgm.startAtSec"；越界/缺键 = undefined */
export const getPath = (root: unknown, path: string): unknown => {
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let cur: unknown = root;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
};

const deepEq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * 判分：post = 执行终态（store 快照的可判子集），fixture = 初始态，calls = 实际轨迹。
 * 返回 failures[]（空 = PASS）。
 */
export const evaluateBenchJudge = (
  post: unknown,
  fixture: unknown,
  judge: BenchTask['judge'],
  calls: Array<{tool: string}> = [],
): BenchJudgeFailure[] => {
  const failures: BenchJudgeFailure[] = [];
  for (const a of judge.assert) {
    const got = getPath(post, a.path);
    if (a.absent) {
      if (got !== undefined) failures.push({path: a.path, kind: 'eq', got, want: '(absent)'});
    } else if (a.eq !== undefined) {
      if (!deepEq(got, a.eq)) failures.push({path: a.path, kind: 'eq', got, want: a.eq});
    } else if (a.about !== undefined) {
      const tol = a.tol ?? 1e-6;
      if (typeof got !== 'number' || Math.abs(got - a.about) > tol) {
        failures.push({path: a.path, kind: 'about', got, want: `${a.about}±${tol}`});
      }
    } else if (a.len !== undefined) {
      if (!Array.isArray(got) || got.length !== a.len) {
        failures.push({path: a.path, kind: 'len', got: Array.isArray(got) ? got.length : got, want: a.len});
      }
    } else {
      failures.push({path: a.path, kind: 'eq', got: '断言缺 eq/about/len', want: null});
    }
  }
  for (const p of judge.unchanged ?? []) {
    const got = getPath(post, p);
    const want = getPath(fixture, p);
    if (!deepEq(got, want)) failures.push({path: p, kind: 'unchanged', got, want});
  }
  for (const f of judge.forbiddenCalls ?? []) {
    if (calls.some((c) => c.tool === f)) failures.push({path: '(trajectory)', kind: 'forbidden', got: f, want: '未调用'});
  }
  return failures;
};

/** 判分器自检（selftest 核心）：参考轨迹必须全过；错误轨迹必须至少挂一条目标断言 */
export const judgeDiscriminates = (
  postOfRef: unknown,
  postOfBad: unknown,
  fixture: unknown,
  task: BenchTask,
): {refPass: boolean; badCaught: boolean; badFailures: BenchJudgeFailure[]} => {
  const refFailures = evaluateBenchJudge(postOfRef, fixture, task.judge, task.refTrajectory);
  const badFailures = evaluateBenchJudge(postOfBad, fixture, task.judge, task.badTrajectory ?? []);
  return {refPass: refFailures.length === 0, badCaught: badFailures.length > 0, badFailures};
};
