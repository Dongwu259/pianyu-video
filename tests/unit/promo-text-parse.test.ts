/**
 * 说服力场景文案解析（shared/promo-text-parse.ts）单元测试
 *
 * 运行方式：node server/node_modules/tsx/dist/cli.mjs tests/unit/promo-text-parse.test.ts
 */

import assert from 'node:assert/strict';
import {
  parseDiffRows,
  parsePriceAnchor,
  parseStatLine,
  formatStatValue,
  parseHighlightSegments,
  parseTestimonial,
  tokenizeCaption,
  parseTimelineNode,
  parsePricingTier,
  parseBeforeAfterMetric,
  parseDateSegments,
  parseDataPointLine,
  parseDataSeries,
} from '../../src/shared/promo-text-parse.ts';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

console.log('parseStatLine:');
{
  const a = parseStatLine('99.9% 服务可用率')!;
  assert.equal(a.value, 99.9);
  assert.equal(a.decimals, 1);
  assert.equal(a.suffix, '%');
  assert.equal(a.label, '服务可用率');
  assert.equal(a.groupDigits, false);
  const b = parseStatLine('3000万+ 累计用户')!;
  assert.equal(b.value, 3000);
  assert.equal(b.suffix, '万+');
  assert.equal(b.label, '累计用户');
  const c = parseStatLine('1,200,000 次API调用')!;
  assert.equal(c.value, 1200000);
  assert.equal(c.groupDigits, true);
  assert.equal(c.label, '次API调用');
  const d = parseStatLine('3x 效率提升')!;
  assert.equal(d.value, 3);
  assert.equal(d.decimals, 0);
  assert.equal(d.suffix, 'x');
  const e = parseStatLine('1，200，000 全角千分位')!;
  assert.equal(e.value, 1200000);
  assert.equal(e.groupDigits, true);
  const f = parseStatLine('42');
  assert.ok(f);
  assert.equal(f!.label, '');
  assert.equal(f!.suffix, '');
  ok('数值/后缀/标签/千分位全分支解析正确');
}
{
  assert.equal(parseStatLine('服务可用率 99.9%'), null);
  assert.equal(parseStatLine(''), null);
  assert.equal(parseStatLine('   '), null);
  assert.equal(parseStatLine('1.2.3 坏数字'), null);
  ok('非数值开头 / 空 / 非法数字返回 null（调用方按原文降级展示）');
}

console.log('formatStatValue:');
{
  const item = parseStatLine('1,250,000 累计下载')!;
  assert.equal(formatStatValue(item, 0), '0');
  assert.equal(formatStatValue(item, 1250000), '1,250,000');
  assert.equal(formatStatValue(item, 50000), '50,000');
  const dec = parseStatLine('99.9% 可用率')!;
  assert.equal(formatStatValue(dec, 0), '0.0');
  assert.equal(formatStatValue(dec, 55.56), '55.6');
  const plain = parseStatLine('3000万 用户')!;
  assert.equal(formatStatValue(plain, 1500), '1500');
  ok('滚动过程保持原文小数位与千分位格式');
}

console.log('parseHighlightSegments:');
{
  const segs = parseHighlightSegments('让「效率翻倍」成为日常');
  assert.deepEqual(segs, [
    {text: '让', highlight: false},
    {text: '效率翻倍', highlight: true},
    {text: '成为日常', highlight: false},
  ]);
  const multi = parseHighlightSegments('『快』而且「省心」');
  assert.equal(multi.filter((s) => s.highlight).length, 2);
  assert.equal(multi.map((s) => s.text).join(''), '快而且省心');
  const none = parseHighlightSegments('普通文案无高亮');
  assert.deepEqual(none, [{text: '普通文案无高亮', highlight: false}]);
  assert.deepEqual(parseHighlightSegments(''), [{text: '', highlight: false}]);
  const en = parseHighlightSegments('ship "faster" today');
  assert.deepEqual(en[1], {text: 'faster', highlight: true});
  ok('中英引号切分、无引号回退、空串安全');
}

console.log('parseTestimonial:');
{
  const t = parseTestimonial(['用了一周，周报时间从 3 小时缩到 20 分钟。', '王琳，产品负责人', '5']);
  assert.equal(t.quote, '用了一周，周报时间从 3 小时缩到 20 分钟。');
  assert.equal(t.author, '王琳');
  assert.equal(t.role, '产品负责人');
  assert.equal(t.rating, 5);
  const split = parseTestimonial(['q', '张三 · 某科技公司 CEO']);
  assert.equal(split.author, '张三');
  assert.equal(split.role, '某科技公司 CEO');
  ok('引言/署名分隔/星级解析正确');
}
{
  const noStars = parseTestimonial(['很好用']);
  assert.equal(noStars.rating, 5);
  assert.equal(noStars.author, '');
  const zero = parseTestimonial(['q', 'n', '0']);
  assert.equal(zero.rating, 0);
  const bad = parseTestimonial(['q', 'n', '9']);
  assert.equal(bad.rating, 5);
  const fb = parseTestimonial([], '回退引言');
  assert.equal(fb.quote, '回退引言');
  const fb2 = parseTestimonial(undefined, '');
  assert.equal(fb2.quote, '');
  ok('星级缺省 5 / 非法钳制 / 引言回退链');
}

console.log('tokenizeCaption:');
{
  const zh = tokenizeCaption('用 AI 剪片');
  assert.deepEqual(
    zh.map((u) => ({t: u.text, c: u.countable})),
    [
      {t: '用', c: true},
      {t: ' ', c: false},
      {t: 'AI', c: true},
      {t: ' ', c: false},
      {t: '剪', c: true},
      {t: '片', c: true},
    ],
  );
  assert.equal(zh.map((u) => u.text).join(''), '用 AI 剪片');
  const en = tokenizeCaption('ship it faster');
  assert.equal(en.filter((u) => u.countable).length, 3);
  assert.equal(en.filter((u) => !u.countable).length, 2); // 两个空格单元
  const punct = tokenizeCaption('好，快！');
  assert.equal(punct.filter((u) => u.countable).length, 2); // 标点不计时
  assert.deepEqual(tokenizeCaption(''), []);
  ok('中英分词/空格保留/标点不计时/空串安全');
}

console.log('parseTimelineNode / parsePricingTier / parseBeforeAfterMetric / parseDateSegments:');
{
  const n1 = parseTimelineNode('v1.0 内测发布');
  assert.deepEqual(n1, {tag: 'v1.0', label: '内测发布'});
  const n2 = parseTimelineNode('2024Q3');
  assert.deepEqual(n2, {tag: '2024Q3', label: ''});
  const t1 = parsePricingTier('专业版 ¥99 全功能不限量协作');
  assert.deepEqual(t1, {name: '专业版', price: '¥99', desc: '全功能不限量协作'});
  const t2 = parsePricingTier('免费版');
  assert.deepEqual(t2, {name: '免费版', price: '', desc: ''});
  ok('时间线节点与定价档位解析正确');
}
{
  assert.deepEqual(parseBeforeAfterMetric('16小时 → 5分钟'), {before: '16小时', after: '5分钟'});
  assert.deepEqual(parseBeforeAfterMetric('3 小时->20 分钟'), {before: '3 小时', after: '20 分钟'});
  assert.equal(parseBeforeAfterMetric('没有箭头的行'), null);
  assert.equal(parseBeforeAfterMetric('→ 只有一边'), null);
  ok('前后对比指标行解析（→/-> 双写法，无箭头返回 null）');
}
{
  assert.deepEqual(parseDateSegments('2026.09.01'), ['2026', '09', '01']);
  assert.deepEqual(parseDateSegments('2026-9-1'), ['2026', '9', '1']);
  assert.deepEqual(parseDateSegments('3 天后'), ['3 天后']); // 非日期整段
  assert.deepEqual(parseDateSegments(''), []);
  ok('日期分段（保留非日期原文、空串安全）');
}

console.log('parseDataPointLine（3D 图表数据行）:');
{
  // 标签在前（主写法）
  const a = parseDataPointLine('月活用户 120万')!;
  assert.deepEqual(a, {label: '月活用户', value: 1200000, display: '120万'});
  const b = parseDataPointLine('一月 120')!;
  assert.deepEqual(b, {label: '一月', value: 120, display: '120'});
  const c = parseDataPointLine('Q1: 3.2万')!;
  assert.deepEqual(c, {label: 'Q1', value: 32000, display: '3.2万'});
  const d = parseDataPointLine('一月120')!; // 分隔符可省
  assert.deepEqual(d, {label: '一月', value: 120, display: '120'});
  const e = parseDataPointLine('增长率 12%')!;
  assert.deepEqual(e, {label: '增长率', value: 12, display: '12%'});
  ok('标签在前：万/亿折算、分隔符可省、% 不折算、display 保留原文');
}
{
  // 数值在前（StatCounter 同款）
  const a = parseDataPointLine('120万 月活用户')!;
  assert.deepEqual(a, {label: '月活用户', value: 1200000, display: '120万'});
  const b = parseDataPointLine('99.9% 服务可用率')!;
  assert.deepEqual(b, {label: '服务可用率', value: 99.9, display: '99.9%'});
  const c = parseDataPointLine('1,200 次调用')!;
  assert.deepEqual(c, {label: '次调用', value: 1200, display: '1,200'});
  const d = parseDataPointLine('42')!; // 裸数值：标签为空
  assert.deepEqual(d, {label: '', value: 42, display: '42'});
  const e = parseDataPointLine('2.5K 关注')!;
  assert.deepEqual(e, {label: '关注', value: 2500, display: '2.5K'});
  ok('数值在前：千分位/裸数值/K 后缀、标签可空');
}
{
  assert.equal(parseDataPointLine('没有数字的行'), null);
  assert.equal(parseDataPointLine('1.2.3 坏数字'), null);
  assert.equal(parseDataPointLine(''), null);
  assert.equal(parseDataPointLine('   '), null);
  ok('无数字 / 坏数字 / 空行返回 null');
}

console.log('parseDataSeries（min/max 夹紧与回退）:');
{
  const fallback = [
    {label: '示1', value: 1, display: '1'},
    {label: '示2', value: 2, display: '2'},
    {label: '示3', value: 3, display: '3'},
  ];
  const opts = {min: 3, max: 4, fallback};
  // 有效 5 条（混入 2 条无效行被丢弃）→ 截到 max=4
  const many = parseDataSeries(['一月 10', '坏行', '二月 20', '三月 30', '四月 40', '五月 50', '又一坏行'], opts);
  assert.equal(many.length, 4);
  assert.equal(many[0].label, '一月');
  assert.equal(many[3].label, '四月');
  // 有效 2 条 < min=3 → 整体回退 fallback
  const few = parseDataSeries(['一月 10', '坏行', '二月 20'], opts);
  assert.deepEqual(few, fallback);
  // 空/未给 features → 回退
  assert.deepEqual(parseDataSeries(undefined, opts), fallback);
  assert.deepEqual(parseDataSeries([], opts), fallback);
  ok('无效行丢弃、超 max 截断、不足 min 整体回退、空输入回退');
}

// ====== 批 2 真缺口：parseDiffRows / parsePriceAnchor（2026-10-13）======
{
  const rows = parseDiffRows(['- 旧字幕偏晚 0.4s', '+ 对齐节拍 2.4', '上下文行', '+', '', '-纯前缀也行']);
  assert.equal(rows.length, 4, '空前缀行与空行被丢弃');
  assert.deepEqual(rows[0], {kind: 'del', text: '旧字幕偏晚 0.4s'});
  assert.deepEqual(rows[1], {kind: 'add', text: '对齐节拍 2.4'});
  assert.deepEqual(rows[2], {kind: 'ctx', text: '上下文行'});
  assert.deepEqual(rows[3], {kind: 'del', text: '纯前缀也行'}, '前缀后无空格也剥');
  const capped = parseDiffRows(Array.from({length: 14}, (_, i) => `+第${i}行`));
  assert.equal(capped.length, 10, '超过 maxRows=10 截断');
  assert.deepEqual(parseDiffRows(undefined), []);
  ok('parseDiffRows：前缀语义/空行丢弃/截断/空输入');
}
{
  const {perks, badges} = parsePriceAnchor(['本地不限 token', '!30 天可退', '模型免费更新', '!正版授权', '!本地运行', '!多余徽章', '']);
  assert.deepEqual(perks, ['本地不限 token', '模型免费更新']);
  assert.deepEqual(badges, ['30 天可退', '正版授权', '本地运行'], '徽章超 3 截断');
  assert.deepEqual(parsePriceAnchor(undefined), {perks: [], badges: []});
  ok('parsePriceAnchor：「!」徽章拆分/上限截断/空输入');
}

console.log(`\npromo-text-parse: ${passed} 组断言全部通过`);
if (passed < 10) process.exit(1);
