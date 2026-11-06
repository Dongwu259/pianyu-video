/**
 * MCP 一键接入（services/mcpAgentInstall.ts）单元测试
 *
 * 运行方式：node server/node_modules/tsx/dist/cli.mjs tests/unit/mcp-agent-install.test.ts
 * （被测模块为纯 Node 实现，不依赖 electron；home 目录用临时目录注入模拟）
 *
 * 覆盖：(a) 全新安装 kimi（目录不存在→创建文件）→ (b) claude 合并保留旧条目 + 备份 →
 * (c) 重复安装幂等 → (d) 损坏 JSON 中文报错且不改动文件 → (e) listAgents 判定 →
 * (f) MCP_AGENT_IDS 六家 id 全量在列（IPC 守卫的校验源）→
 * (g) 端口自愈 healAgentConfigs（改 URL 不动 token/吊销不恢复/损坏跳过/非本机形态不碰）。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {installAgent, listAgents, MCP_AGENT_IDS, healAgentConfigs} from '../../src/main/services/mcpAgentInstall.ts';

const URL = 'http://127.0.0.1:17890/mcp';
const TOKEN = 'tok-abc123';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

/** 造一个临时 home 目录（用例间互不影响） */
const mkHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pianyu-mcp-agent-'));

const homes: string[] = [];
const trackHome = () => {
  const h = mkHome();
  homes.push(h);
  return h;
};

const main = () => {
  // (a) 全新安装 kimi：.kimi-code 目录不存在 → 自动创建目录与文件
  console.log('(a) 全新安装 kimi:');
  {
    const home = trackHome();
    const res = installAgent(home, 'kimi', {url: URL, token: TOKEN});
    const cfgPath = path.join(home, '.kimi-code', 'mcp.json');
    assert.equal(res.configPath, cfgPath);
    assert.ok(fs.existsSync(cfgPath), '配置文件应被创建');
    const json = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    assert.deepEqual(
      json,
      {mcpServers: {pianyu: {url: URL, headers: {Authorization: `Bearer ${TOKEN}`}}}},
      'kimi 条目应为 {url, headers}（无 type 字段）',
    );
    assert.equal(res.backupPath, undefined, '全新安装不应有备份');
    assert.ok(!fs.existsSync(`${cfgPath}.pianyu-bak`), '全新安装不应生成备份文件');
    assert.match(res.message, /重启 Kimi Code CLI 后生效/);
    ok('目录不存在时自动创建，条目格式为 {url, headers}（无 type）');
  }

  // (b) claude 已有其它 server 条目 → 合并后旧条目与顶层字段保留 + 备份生成
  console.log('(b) claude 合并与备份:');
  {
    const home = trackHome();
    const cfgPath = path.join(home, '.claude.json');
    const original = {globalShortcut: 'ctrl+x', mcpServers: {other: {command: 'npx', args: ['foo']}}};
    fs.writeFileSync(cfgPath, JSON.stringify(original, null, 2));
    const res = installAgent(home, 'claude', {url: URL, token: TOKEN});
    const json = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    assert.equal(json.globalShortcut, 'ctrl+x', '顶层其它字段应保留');
    assert.deepEqual(json.mcpServers.other, {command: 'npx', args: ['foo']}, '已有 server 条目应保留');
    assert.deepEqual(
      json.mcpServers.pianyu,
      {type: 'http', url: URL, headers: {Authorization: `Bearer ${TOKEN}`}},
      'claude 条目应带 type:http',
    );
    assert.equal(res.backupPath, `${cfgPath}.pianyu-bak`);
    assert.equal(fs.readFileSync(res.backupPath as string, 'utf8'), JSON.stringify(original, null, 2), '备份内容应等于原文件');
    ok('合并保留旧条目/顶层字段，备份生成且内容正确');
  }

  // (c) 重复安装幂等：内容一致、已有备份不被覆盖
  console.log('(c) 重复安装幂等:');
  {
    const home = trackHome();
    const cfgPath = path.join(home, '.claude.json');
    const original = {mcpServers: {other: {command: 'npx'}}};
    fs.writeFileSync(cfgPath, JSON.stringify(original));
    installAgent(home, 'claude', {url: URL, token: TOKEN});
    const first = fs.readFileSync(cfgPath, 'utf8');
    const bakFirst = fs.readFileSync(`${cfgPath}.pianyu-bak`, 'utf8');
    installAgent(home, 'claude', {url: URL, token: TOKEN});
    assert.equal(fs.readFileSync(cfgPath, 'utf8'), first, '重复安装内容应一致');
    assert.equal(fs.readFileSync(`${cfgPath}.pianyu-bak`, 'utf8'), bakFirst, '已有备份不应被覆盖');
    assert.equal(bakFirst, JSON.stringify(original), '备份应保持首次的原文件内容');
    ok('内容一致、备份沿用首次（不覆盖）');
  }

  // (d) 损坏 JSON：中文报错且文件未被改动（也不生成备份/残留临时文件）
  console.log('(d) 损坏 JSON:');
  {
    const home = trackHome();
    const cfgPath = path.join(home, '.claude.json');
    const broken = '{ "mcpServers": { 损坏';
    fs.writeFileSync(cfgPath, broken);
    assert.throws(
      () => installAgent(home, 'claude', {url: URL, token: TOKEN}),
      new RegExp(`配置文件 JSON 损坏，未改动，请手动修复：${cfgPath.replace(/[\\/.*[\]{}()?+^$|]/g, '\\$&')}`),
    );
    assert.equal(fs.readFileSync(cfgPath, 'utf8'), broken, '文件不应被改动');
    assert.ok(!fs.existsSync(`${cfgPath}.pianyu-bak`), '损坏时不应生成备份');
    assert.ok(!fs.existsSync(`${cfgPath}.pianyu-tmp`), '不应残留临时文件');
    ok('中文报错、文件未改动、无备份与临时文件残留');
  }

  // (e) listAgents 的 installed / configured 判定
  console.log('(e) listAgents 判定:');
  {
    const home = trackHome();
    let agents = listAgents(home);
    assert.deepEqual(
      agents.map((a) => [a.id, a.installed, a.configured]),
      [
        ['kimi', false, false],
        ['claude', false, false],
        ['codex', false, false],
        ['openclaw', false, false],
        ['zcode', false, false],
        ['dsh', false, false],
      ],
      '空 home 六家均未安装未配置',
    );
    assert.equal(agents.find((a) => a.id === 'kimi')?.configPath, path.join(home, '.kimi-code', 'mcp.json'));
    assert.equal(agents.find((a) => a.id === 'claude')?.configPath, path.join(home, '.claude.json'));
    assert.equal(agents.find((a) => a.id === 'codex')?.configPath, path.join(home, '.codex', 'config.toml'));
    assert.equal(agents.find((a) => a.id === 'dsh')?.configPath, path.join(home, '.dsh', 'cordis.patch.yml'));
    ok('空 home：六家均未安装未配置，configPath 仍给出');

    // kimi 以目录存在判定安装：仅建目录（无 mcp.json）→ installed=true, configured=false
    fs.mkdirSync(path.join(home, '.kimi-code'));
    agents = listAgents(home);
    assert.equal(agents.find((a) => a.id === 'kimi')?.installed, true, 'kimi 目录存在即已安装');
    assert.equal(agents.find((a) => a.id === 'kimi')?.configured, false, '无 mcp.json 时未配置');

    // 写入我们的条目后 configured=true
    installAgent(home, 'kimi', {url: URL, token: TOKEN});
    agents = listAgents(home);
    assert.equal(agents.find((a) => a.id === 'kimi')?.configured, true, '写入 pianyu 条目后已配置');

    // claude 文件存在但无 pianyu 条目 → installed=true, configured=false
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({mcpServers: {other: {command: 'npx'}}}));
    agents = listAgents(home);
    const claude = agents.find((a) => a.id === 'claude');
    assert.equal(claude?.installed, true);
    assert.equal(claude?.configured, false, '无 pianyu 条目时未配置');

    // claude 配置损坏：按未配置展示（不抛错，写入路径才会报中文错）
    fs.writeFileSync(path.join(home, '.claude.json'), '{ 损坏');
    agents = listAgents(home);
    assert.equal(agents.find((a) => a.id === 'claude')?.configured, false, 'JSON 损坏按未配置处理');
    ok('installed/configured 各种形态判定正确');
  }

  // (f) codex：TOML 段写入——已有其它节逐字节保留，重装替换旧 pianyu 段
  console.log('(f) codex TOML:');
  {
    const home = trackHome();
    fs.mkdirSync(path.join(home, '.codex'));
    const cfgPath = path.join(home, '.codex', 'config.toml');
    const original = [
      '# 用户自定义配置',
      'model = "gpt-5.1"',
      '',
      '[mcp_servers.context7]',
      'command = "npx"',
      'args = ["-y", "@upstash/context7-mcp"]',
      '',
      '[profiles.fast]',
      'effort = "low"',
    ].join('\n');
    fs.writeFileSync(cfgPath, original);
    installAgent(home, 'codex', {url: URL, token: TOKEN});
    let toml = fs.readFileSync(cfgPath, 'utf8');
    assert.match(toml, /\[mcp_servers\.pianyu\]/);
    assert.match(toml, new RegExp(`url = "${URL}"`));
    assert.match(toml, /Authorization = "Bearer tok-abc123"/);
    // 其它节与注释原样保留
    assert.ok(toml.includes('# 用户自定义配置'));
    assert.ok(toml.includes('model = "gpt-5.1"'));
    assert.ok(toml.includes('[mcp_servers.context7]'));
    assert.ok(toml.includes('[profiles.fast]'));
    assert.ok(!toml.includes('[mcp_servers.pianyu]\n[mcp_servers'), 'pianyu 段不应嵌进别的节');
    // 重装（换 token）→ 旧 pianyu 段被替换而非追加
    installAgent(home, 'codex', {url: URL, token: 'tok-new'});
    toml = fs.readFileSync(cfgPath, 'utf8');
    assert.equal((toml.match(/\[mcp_servers\.pianyu\]/g) || []).length, 1, '重装后 pianyu 段唯一');
    assert.ok(toml.includes('Bearer tok-new'));
    assert.ok(toml.includes('[profiles.fast]'), '重装仍保留其它节');
    ok('TOML 段写入/替换，其余内容与注释逐字节保留');
    // configured 判定
    let agents = listAgents(home);
    assert.equal(agents.find((a) => a.id === 'codex')?.configured, true);
    // 空目录 fresh install 也能创建
    const home2 = trackHome();
    fs.mkdirSync(path.join(home2, '.codex'));
    installAgent(home2, 'codex', {url: URL, token: TOKEN});
    assert.match(fs.readFileSync(path.join(home2, '.codex', 'config.toml'), 'utf8'), /\[mcp_servers\.pianyu\]/);
    ok('codex configured 判定 + fresh install 建文件');
  }

  // (g) openclaw：JSON5 注释/尾逗号读取 + 嵌套 mcp.servers 键 + 写出严格 JSON
  console.log('(g) openclaw JSON5:');
  {
    const home = trackHome();
    fs.mkdirSync(path.join(home, '.openclaw'));
    const cfgPath = path.join(home, '.openclaw', 'openclaw.json');
    fs.writeFileSync(
      cfgPath,
      [
        '{',
        '  // gateway 配置（带注释与尾逗号）',
        '  "gateway": { "port": 3000, },',
        '  "mcp": {',
        '    "servers": {',
        '      "docs": { "command": "npx", },',
        '      "remote": { "url": "https://example.com/mcp", },',
        '    },',
        '  },',
        '}',
      ].join('\n'),
    );
    installAgent(home, 'openclaw', {url: URL, token: TOKEN});
    const json = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); // 写出后必须是严格 JSON
    assert.equal(json.gateway.port, 3000, '注释剥离后其它配置保留');
    assert.deepEqual(json.mcp.servers.docs, {command: 'npx'}, '已有 server 保留');
    assert.equal(json.mcp.servers.remote.url, 'https://example.com/mcp', '字符串里的 // 不被当注释剥掉');
    assert.deepEqual(json.mcp.servers.pianyu, {
      url: URL,
      transport: 'streamable-http',
      headers: {Authorization: 'Bearer tok-abc123'},
      enabled: true,
    });
    assert.equal(listAgents(home).find((a) => a.id === 'openclaw')?.configured, true);
    // 字符串里的「//」不被当注释剥掉（url 形态保护）
    ok('JSON5 宽松读取（注释/尾逗号），嵌套 mcp.servers 写入，写出严格 JSON');
  }

  // (h) zcode：严格 schema 条目（type/url/headers/enabled），嵌套键
  console.log('(h) zcode 严格 JSON:');
  {
    const home = trackHome();
    fs.mkdirSync(path.join(home, '.zcode', 'cli'), {recursive: true});
    const cfgPath = path.join(home, '.zcode', 'cli', 'config.json');
    fs.writeFileSync(cfgPath, JSON.stringify({theme: 'dark', mcp: {servers: {memory: {type: 'stdio', command: 'npx'}}}}));
    installAgent(home, 'zcode', {url: URL, token: TOKEN});
    const json = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    assert.equal(json.theme, 'dark');
    assert.deepEqual(json.mcp.servers.memory, {type: 'stdio', command: 'npx'}, '已有 server 保留');
    assert.deepEqual(json.mcp.servers.pianyu, {
      type: 'http',
      url: URL,
      headers: {Authorization: 'Bearer tok-abc123'},
      enabled: true,
    }, '条目只含规范键（未知键会被 zcode 静默丢弃）');
    assert.equal(listAgents(home).find((a) => a.id === 'zcode')?.configured, true);
    ok('zcode 嵌套键 + 严格条目形状');
  }

  // (i) dsh：YAML patch 行追加/替换，非列表结构中文报错不动文件
  console.log('(i) dsh YAML patch:');
  {
    const home = trackHome();
    fs.mkdirSync(path.join(home, '.dsh'));
    const cfgPath = path.join(home, '.dsh', 'cordis.patch.yml');
    const original = [
      '# 片语注入前已有的行',
      '- insert:',
      '  - id: mcp-github',
      "    name: '@deepseek-ai/dsh-mcp-client'",
      '    config:',
      '      serverName: github',
      '      transport: stdio',
      '      command: npx',
    ].join('\n');
    fs.writeFileSync(cfgPath, original);
    installAgent(home, 'dsh', {url: URL, token: TOKEN});
    let yml = fs.readFileSync(cfgPath, 'utf8');
    assert.ok(yml.includes('- insert:'));
    assert.ok(yml.includes('serverName: pianyu'));
    assert.ok(yml.includes('transport: streamable-http'));
    assert.ok(yml.includes(`url: "${URL}"`));
    assert.ok(yml.includes('serverName: github'), '已有 patch 行保留');
    assert.ok(yml.startsWith('# 片语注入前已有的行'), '注释保留');
    // 重装换 token：替换 pianyu 行而非追加
    installAgent(home, 'dsh', {url: URL, token: 'tok-new'});
    yml = fs.readFileSync(cfgPath, 'utf8');
    assert.equal((yml.match(/serverName: pianyu/g) || []).length, 1, '重装后 pianyu 行唯一');
    assert.ok(yml.includes('Bearer tok-new'));
    assert.ok(yml.includes('serverName: github'));
    assert.equal(listAgents(home).find((a) => a.id === 'dsh')?.configured, true);
    ok('YAML patch 行追加/替换唯一，已有行与注释保留');

    // 非 patch 列表结构：中文报错且文件不动
    const home2 = trackHome();
    fs.mkdirSync(path.join(home2, '.dsh'));
    const cfg2 = path.join(home2, '.dsh', 'cordis.patch.yml');
    const broken = 'someKey: someValue\n';
    fs.writeFileSync(cfg2, broken);
    assert.throws(() => installAgent(home2, 'dsh', {url: URL, token: TOKEN}), /不是预期的 patch 列表结构/);
    assert.equal(fs.readFileSync(cfg2, 'utf8'), broken, '文件不应被改动');
    ok('非 patch 列表结构中文报错、文件未动');
  }

  // (f) MCP_AGENT_IDS 与文档口径一致：六家 agent 全部可一键接入
  //     （回归锚点：IPC INSTALL_AGENT 守卫曾硬编码只放行 kimi/claude，
  //      导致 Codex/OpenClaw/ZCode/DSH 点「一键接入」报「未知的 agent」）
  console.log('(f) MCP_AGENT_IDS 清单:');
  {
    assert.deepEqual(
      [...MCP_AGENT_IDS],
      ['kimi', 'claude', 'codex', 'openclaw', 'zcode', 'dsh'],
      '运行时 id 清单应与 shared/mcp.ts 的 McpAgentId 类型、mcp.html 文档一致',
    );
    const listed = listAgents(mkHome()).map((a) => a.id);
    assert.deepEqual(listed, [...MCP_AGENT_IDS], 'listAgents 探测范围应与可接入清单一致');
    ok('六家 agent id 全量在列，与 listAgents 探测范围一致');
  }

  // (g) 端口自愈 healAgentConfigs：token 未变的旧地址条目改写为当前地址；
  //     token 重新生成过（吊销语义）不动；已指向当前地址 no-op；损坏文件跳过不抛
  console.log('(g) 端口自愈:');
  {
    const OLD = 'http://127.0.0.1:17890/mcp';
    const NEW = 'http://127.0.0.1:17891/mcp';
    const T = 'tok-heal-aaa';

    // kimi（JSON 条目）：url 改写、token 原值保留
    const home1 = trackHome();
    installAgent(home1, 'kimi', {url: OLD, token: T});
    const healed1 = healAgentConfigs(home1, NEW, T);
    assert.equal(healed1.length, 1);
    assert.equal(healed1[0].id, 'kimi');
    assert.equal(healed1[0].fromUrl, OLD);
    const k = JSON.parse(fs.readFileSync(path.join(home1, '.kimi-code', 'mcp.json'), 'utf8'));
    assert.equal(k.mcpServers.pianyu.url, NEW);
    assert.equal(k.mcpServers.pianyu.headers.Authorization, `Bearer ${T}`);
    ok('kimi 旧端口条目改写为新地址，token 不变');

    // claude：token 已重新生成 = 吊销，自愈不得恢复访问
    const home2 = trackHome();
    installAgent(home2, 'claude', {url: OLD, token: T});
    const healed2 = healAgentConfigs(home2, NEW, 'tok-regenerated');
    assert.equal(healed2.filter((h) => h.id === 'claude').length, 0);
    const c = JSON.parse(fs.readFileSync(path.join(home2, '.claude.json'), 'utf8'));
    assert.equal(c.mcpServers.pianyu.url, OLD, '吊销后 url 不应被改写');
    assert.equal(c.mcpServers.pianyu.headers.Authorization, `Bearer ${T}`);
    ok('token 已重新生成的条目不被自愈改写（吊销语义保持）');

    // 已指向当前地址：no-op
    assert.equal(healAgentConfigs(home1, NEW, T).length, 0);
    ok('已是当前地址时不重复改写');

    // codex（TOML 文本）：pianyu 段内 url 改写，非 pianyu 段逐字节保留
    const home3 = trackHome();
    const codexPath = path.join(home3, '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(codexPath), {recursive: true});
    fs.writeFileSync(codexPath, '[model]\nname = "gpt-5"\n', 'utf8');
    installAgent(home3, 'codex', {url: OLD, token: T});
    assert.ok(healAgentConfigs(home3, NEW, T).some((h) => h.id === 'codex'));
    const raw3 = fs.readFileSync(codexPath, 'utf8');
    assert.ok(raw3.includes(`url = "${NEW}"`));
    assert.ok(raw3.includes(`"Bearer ${T}"`));
    assert.ok(raw3.includes('startup_timeout_sec = 20'), '段内其它键保留');
    assert.ok(raw3.includes('[model]') && raw3.includes('name = "gpt-5"'), '非 pianyu 段逐字节保留');
    ok('codex 文本段自愈：pianyu 段改写、其它内容保留');

    // dsh（YAML patch 行）
    const home4 = trackHome();
    installAgent(home4, 'dsh', {url: OLD, token: T});
    assert.ok(healAgentConfigs(home4, NEW, T).some((h) => h.id === 'dsh'));
    const d = fs.readFileSync(path.join(home4, '.dsh', 'cordis.patch.yml'), 'utf8');
    assert.ok(d.includes(`url: "${NEW}"`));
    assert.ok(d.includes('serverName: pianyu'));
    ok('dsh YAML patch 行自愈');

    // zcode（嵌套 mcp.servers 键路径）
    const home5 = trackHome();
    installAgent(home5, 'zcode', {url: OLD, token: T});
    assert.ok(healAgentConfigs(home5, NEW, T).some((h) => h.id === 'zcode'));
    const z = JSON.parse(fs.readFileSync(path.join(home5, '.zcode', 'cli', 'config.json'), 'utf8'));
    assert.equal(z.mcp.servers.pianyu.url, NEW);
    ok('zcode 嵌套键自愈');

    // 损坏文件：跳过且不改动
    const home6 = trackHome();
    const ocPath = path.join(home6, '.openclaw', 'openclaw.json');
    fs.mkdirSync(path.dirname(ocPath), {recursive: true});
    fs.writeFileSync(ocPath, '{ broken json !!', 'utf8');
    assert.doesNotThrow(() => healAgentConfigs(home6, NEW, T));
    assert.equal(fs.readFileSync(ocPath, 'utf8'), '{ broken json !!', '损坏文件不被改动');
    ok('损坏配置跳过且文件原样');

    // 非本机回环形态（用户手改过）：不碰
    const home7 = trackHome();
    installAgent(home7, 'kimi', {url: OLD, token: T});
    const kimiPath = path.join(home7, '.kimi-code', 'mcp.json');
    const custom = JSON.parse(fs.readFileSync(kimiPath, 'utf8'));
    custom.mcpServers.pianyu.url = 'https://example.com/mcp';
    fs.writeFileSync(kimiPath, JSON.stringify(custom, null, 2));
    assert.equal(healAgentConfigs(home7, NEW, T).length, 0);
    assert.equal(JSON.parse(fs.readFileSync(kimiPath, 'utf8')).mcpServers.pianyu.url, 'https://example.com/mcp');
    ok('非本机回环形态的条目不被自愈碰');
  }

  console.log(`\n===== ${passed} 项全部通过 =====`);
};

try {
  main();
} catch (err) {
  console.error('\n✗ 测试失败：', err);
  process.exitCode = 1;
} finally {
  for (const h of homes) {
    try {
      fs.rmSync(h, {recursive: true, force: true});
    } catch {
      // 清理失败不影响测试结果
    }
  }
}
