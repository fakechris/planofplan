# Agent Status API(`/api/agent-status`)

> 实时 coding-agent 状态快照,给本机外设消费。第一个消费方是桌面宠
> (`moyu-badge/sender`,职责只剩"拉本 API → BLE 推给设备")。
> 状态语义母版:codex hatch-pet 9 态 + dsh 状态,收敛为 6 态。

## 端点

```
GET /api/agent-status              # 带 3s TTL 缓存
GET /api/agent-status?force=1      # 跳过缓存强制重扫
GET /api/agent-status?disable=amp,agy   # 本次临时禁用若干源
```

## 响应

```json
{
  "generatedAt": 1788685788123,
  "slots": [
    { "slot": 0, "occupied": true,  "source": "zcode", "name": "zcode",
      "state": 1, "stateName": "working", "progress": 255, "text": "turn live" },
    { "slot": 1, "occupied": true,  "source": "codex", "name": "refactor",
      "state": 2, "stateName": "needs-you", "progress": 255, "text": "refactor" },
    { "slot": 2, "occupied": false, "source": "", "name": "",
      "state": 0, "stateName": "idle", "progress": 0, "text": "" },
    { "slot": 3, "occupied": false, "source": "", "name": "",
      "state": 0, "stateName": "idle", "progress": 0, "text": "" }
  ]
}
```

恒 4 项;`occupied=false` 的槽是"请清空"的占位(state=0)。消费方把空槽也
发出去,设备端才能把消失的会话从屏上撤下来。

## 6 态模型

| state | stateName | 语义 |
|---|---|---|
| 0 | idle | 空(槽隐藏) |
| 1 | working | 跑步中/思考中 |
| 2 | needs-you | 等批准/等输入(最高优先级) |
| 3 | review | 本轮完成,待你审 |
| 4 | failed | 出错 |
| 5 | celebrate | 完成庆祝 |

`progress`:0-100;255 = 该源不提供进度。

## 槽位归并规则

1. 全部源的会话按优先级排序:**needs-you > failed > working > review > celebrate**,
   取前 4 进槽;
2. `(source, name)` 键跨轮询**稳定占位**——同一个会话不会在屏上跳来跳去;
3. 会话消失(完成/过期/源下线)即释放槽位,不残留。

## 各源检测机制(精度递减)

| 源 | 机制 | 精度 |
|---|---|---|
| dsh | HTTP `127.0.0.1:3080/obvious-grid/status`(可用 `PLANOFPLAN_DSH_URL` 改) | 准 |
| opencode | HTTP `127.0.0.1:4096` 的 `/session` + `/session/status` + per-session `/permission`(非空 = needs-you;`PLANOFPLAN_OPENCODE_URL`) | 准 |
| claude | hooks 状态文件 `~/.config/deskpet-sender/claude-*.json`(装法:`moyu-badge/sender/hooks/install-claude.sh`);无 hooks 时 transcript mtime 兜底 | 准 / 启发式 |
| codex | `~/.codex/sessions/**/meta.json`:active 且 120s 内→working;failed→failed;completed 且 10min 内→review | 启发式 |
| kimi | `~/.kimi-code/session_index.jsonl` + sessionDir mtime ≤150s | 启发式 |
| zcode | `~/.zcode/cli/rollout/*.jsonl` mtime ≤150s(桌面端开着不算活跃) | 启发式 |
| amp | 进程名精确匹配(`ps`) | 只有 working |
| droid | hooks 文件(同 claude)→ `~/.factory/sessions` jsonl 尾行关键词 → 进程 | 分层 |
| grok | `grok sessions list` 表 + UPDATED 日期 | 启发式 |
| agy | 进程 etime(无本地会话存储) | 只有 working |

mtime 类的物理上限:"最近动过"≠"此刻在跑";这些 CLI 没有状态接口时的
最好近似。某源给出正式接口后只改 `src/agent-status.ts` 一处。

## 实时性

轮询模型,非事件推送:源痕迹 → 本端点(TTL 3s 缓存)→ 消费方轮询
(桌宠 sender 默认 5s)→ 设备刷新(1s)。端到端 5-10 秒量级。

## 消费示例

```bash
curl -s http://127.0.0.1:9288/api/agent-status | jq .
```

```python
import json, urllib.request
with urllib.request.urlopen("http://127.0.0.1:9288/api/agent-status", timeout=3) as r:
    slots = json.load(r)["slots"]
```

## 测试与演进

- `test/agent-status.test.ts`:槽位归并(优先级/稳定占位/释放)+ 注入根目录
  的 poller 单测 + 全管线冒烟;
- 新接一个 agent 源:加一个 `pollXxx()` + 在 `getAgentStatus` 的 jobs 里注册
  + 上表补一行,消费方零改动。
