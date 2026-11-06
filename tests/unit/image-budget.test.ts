/**
 * 看图预算（shared/image-budget.ts）单测：同帧重发上限 / 会话总量上限 / 键桶容差 / 配额占用。
 * 跑法：node server/node_modules/tsx/dist/cli.mjs tests/unit/image-budget.test.ts
 */
import {
  createImageBudget,
  resetImageBudget,
  takeImageBudget,
  frameBudgetKey,
  FRAME_BUCKET_SEC,
  IMAGE_BUDGET_MAX_PER_FRAME,
  IMAGE_BUDGET_MAX_TOTAL,
} from '../../src/shared/image-budget';

let passed = 0;
let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) passed++;
  else {
    failed++;
    console.error(`FAIL ${msg}`);
  }
};

// ====== 键桶：时间容差归到同桶 ======
ok(frameBudgetKey('a.mp4', 1.2) === frameBudgetKey('a.mp4', 1.24), '同桶：0.04s 抖动归同键');
ok(frameBudgetKey('a.mp4', 1.2) !== frameBudgetKey('a.mp4', 1.3), '跨桶：越过 1.25 边界分不同键');
ok(frameBudgetKey('a.mp4', 1.2) !== frameBudgetKey('b.mp4', 1.2), '不同素材不同键');
ok(frameBudgetKey('a.mp4', 1.2).endsWith(`@${Math.round(1.2 / FRAME_BUCKET_SEC)}`), '键 = 路径@时间桶');

// ====== 同帧重发上限 ======
{
  const b = createImageBudget();
  ok(takeImageBudget(b, 'k').allow, '首次允许');
  ok(takeImageBudget(b, 'k').allow, '重看一次允许（panel 旧图替换占位后的合法重看）');
  const v3 = takeImageBudget(b, 'k');
  ok(!v3.allow && /上限/.test(v3.reason ?? ''), '第三次拒绝并给原因');
  ok(takeImageBudget(b, 'other').allow, '拒绝不影响其它帧');
  ok(b.total === 3, '配额只计成功次数');
}

// ====== 会话总量上限 ======
{
  const b = createImageBudget();
  let denied = 0;
  for (let i = 0; i < IMAGE_BUDGET_MAX_TOTAL + 5; i++) {
    if (!takeImageBudget(b, `frame-${i}`).allow) denied++;
  }
  ok(denied === 5, `总量 ${IMAGE_BUDGET_MAX_TOTAL} 张封顶，超量全拒`);
  ok(/已达上限/.test(takeImageBudget(b, 'x').reason ?? ''), '总量拒绝原因可回告模型');
}

// ====== 独立实例互不影响 ======
{
  const a = createImageBudget();
  const b = createImageBudget();
  takeImageBudget(a, 'k');
  ok(b.total === 0, '实例隔离');
}

// ====== 复位（set_storyboard 新会话语义） ======
{
  const b = createImageBudget();
  takeImageBudget(b, 'x@0');
  takeImageBudget(b, 'y@0');
  resetImageBudget(b);
  ok(b.total === 0 && b.perKey.size === 0, '复位清空总量与按帧计数');
  ok(takeImageBudget(b, 'x@0').allow === true, '复位后同帧可重新附图');
}

console.log(`passed=${passed} failed=${failed}`);
if (failed > 0) process.exit(1);
