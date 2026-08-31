// bun test 全局预加载(bunfig.toml [test] preload):把 PLANOFPPLAN_HOME
// 指到每进程一次的临时目录。两重目的:
// 1. 定价快照等按 home 解析的数据文件不随开发机真实状态漂移;
// 2. 任何意外写 home 的测试路径(config/凭据)不污染真实 ~/.planofplan。
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (!process.env.PLANOFPPLAN_HOME) {
  process.env.PLANOFPPLAN_HOME = mkdtempSync(join(tmpdir(), 'planofplan-test-home-'));
}
// provider 根隔离:不显式传 root 的发现路径不许碰真实 home(antigravity
// 实测踩过——本机有数据导致测试多扫一个文件)。指向不存在的临时路径。
if (!process.env.ANTIGRAVITY_HOME) {
  process.env.ANTIGRAVITY_HOME = join(tmpdir(), 'planofplan-test-none-');
}
