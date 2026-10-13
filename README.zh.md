# dsh-auto-compact

DeepSeek Harness 的早期自动压缩插件：当实测上下文占用达到所路由模型上下文窗口的可配置比例时——**默认 40%**——即压缩历史，而不是等到宿主持有引擎默认的 80% 阈值。

## 做什么

宿主自带 `@deepseek-ai/dsh-compaction-basic`，其自动路径本就在按模型阈值（默认窗口的 80%）压缩历史。本插件把该阈值提前，并补一个空闲边界清扫，共三条机制：

1. **策略同步（主路径）。** 插件在每个 step 边界把自己的阈值投影到已挂载引擎的解析后配置上；引擎自己的 `agent/pre-step` 监听器随即以同步后的阈值在轮次中途压缩，完整复用其原生的均衡区间选择、摘要、持久化提交与溢出恢复。同步是幂等的且会反复自我重申，运行时改配置、引擎重载都能在下一步生效，无需重启。
2. **压力监听（兜底）。** 当引擎的自动压缩被关掉（`auto: false`）时，插件自己以同一阈值驱动引擎的公开 `compactIfNeeded()` 压力路径。
3. **空闲清扫（边界保证）。** 每次转入 idle 时测量压力，达到阈值即走引擎的公开 `compactNow()`（与 `/compact` 同一入口）执行压缩。它兜住"最后一步之后才越过阈值"的情况（超长末条助手消息、超大入站消息），并且在引擎不暴露可补丁策略的组合下依然有效。

一切依赖皆特性探测：没有压缩引擎、token 计量或 LLM 服务的组合降级为只打日志，任何监听器都不会打断轮次。`/autocompact` 命令可查看实时阈值、压力与上次执行结果。

## 安装

```bash
dsh plugin --profile desktop add github:SanQing-justsoso/dsh-auto-compact
```

装完重启 GUI。也可以用本地绝对路径安装（无需发布）：

```bash
dsh plugin --profile desktop add /绝对路径/dsh-auto-compact
```

## 配置

通过 profile patch（`~/.dsh/profiles/desktop/cordis.patch.yml`）或配置编辑器设置：

```yaml
- id: auto-compact
  name: dsh-auto-compact
  config:
    thresholdRatio: 0.4      # 上下文窗口的 40% 处触发压缩
    headroomTokens: 512      # 可选；当摘要 maxTokens 跟随旧 headroom 时一并跟随
    modelPolicies:           # 可选的按路由覆盖
      - provider: tokenhub
        model: kimi-k3
        thresholdRatio: 0.3
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关；volatile（可热改）。 |
| `thresholdRatio` | `0.4` | 触发压缩的窗口占比，须在 (0, 1)；volatile。 |
| `retainRatio` / `retainTokens` | — | 可选的保留策略覆盖，投影到引擎（二选一，tokens 优先）。`retainRatio` 必须小于最紧的有效阈值。 |
| `headroomTokens` | — | 可选的引擎 headroom 覆盖；若摘要 `maxTokens` 原本跟随旧 headroom，则一并跟随。 |
| `cooldownSeconds` | `30` | 同一 agent 两次空闲清扫的最小间隔秒数；volatile。 |
| `modelPolicies` | `[]` | 精确 `{ provider, model, thresholdRatio }` 覆盖，合并进引擎的按模型策略表；仅加载时生效。 |

配置非法在加载期即失败（fail-fast），与其他 dsh 策略插件一致。

## 工作原理（两种组合形态）

DSH 有两种组合形态，插件对两者都解析引擎：

- **基础组合**（headless、SDK、minimal）：`@deepseek-ai/dsh-compaction-basic` 挂在根平面，`ctx.get("compaction")` 直接可达。
- **web/desktop 应用**：同一个引擎挂在 agent preset 的隔离组里（`isolate: { compaction: true }`），根平面消费者看不见它。因此每个触发点都先通过 preset 注册表的文档化缝隙 `agentPresets.serviceFor(agent, "compaction")` 取该 agent 自己的引擎实例，取不到再回落根平面。

投影出的策略落在引擎的解析后配置上，引擎原生的 `agent/pre-step` 监听器随即以同步后的阈值在轮次中途压缩。同步幂等且每步自我重申，运行时改配置、引擎重载均无需重启即可生效。

## 选择阈值

```bash
/autocompact        # 状态：阈值、引擎策略、路由、当前压力、上次执行
/autocompact 30     # 把阈值设为上下文窗口的 30%
/autocompact 42.5%  # 支持小数和结尾的 %
```

设置通过 settings 缝隙写入 profile patch——与 GUI 插件配置表单同一条写路——**重启后仍生效**，并实时应用到运行中的引擎（下一步起算）。1–99 之外的值、或低于已配置 `retainRatio` 的阈值会被拒绝并说明原因。GUI 的 Plugins 页（插件管理器）里也会为 `dsh-auto-compact` 渲染同名表单，改的是同一份配置。

## 验证

`/autocompact` 输出当前会话的：武装阈值、引擎生效策略、路由、当前压力、上次执行结果。desktop 装好后应看到 `engine: policy synced (automatic compaction on; active threshold 40%)`——该命令先落策略再报告，因此即使会话还没跑过任何一步（新进程刚起来、刚恢复会话、长时间空闲），读数也是正确的。宿主日志视图中可看到 `auto-compact:` 相关行：武装阈值、压力越线、每次清扫压缩。会话日志中每次压缩都记录为 `compaction/start` → `compaction/summary` → `compaction/end`，轮次中途的压缩 `turn` 为当轮次号，空闲清扫的为 `null`。

### 已验证行为（本地 mock LLM 真实启动，A/B 对照）

同一对话、同一 headroom，仅阈值不同：

| 组合 | 引擎阈值 | step 边界压力（约 9.2K/16K = 57%） | 轮次中途压缩 | 空闲清扫压缩 |
|---|---|---|---|---|
| 本插件开启 | 0.4（插件投影） | 57% | 发生（`turn:1`） | 发生（`turn:null`，shadowed 3,521 tokens） |
| 本插件关闭（引擎 0.8 + 同 headroom） | 0.8（profile 直配） | 57% | 不发生 | 不发生（插件关闭） |

即：57% 处的中途压缩只可能由 40% 阈值触发；空闲清扫为本插件独有增量。

隔离 preset 形态（复现 desktop 挂载：引擎在 `isolate: { compaction: true }` 组内、根平面行禁用）下同样验证通过：`/autocompact` 实测输出 `engine: policy synced … active threshold 40%` 与 `last run: compacted 3 items (~3,521 tokens) while idle`，两次压缩（`turn:1` 中途 + `turn:null` 空闲）均经隔离引擎完成。

## 测试

离线单元测试，假 cordis 上下文，无需网络与真实启动：

```bash
pnpm install   # 或：ln -sfn "/Applications/DeepSeek Harness.app/Contents/Resources/app/dsh/node_modules" node_modules
node test/run-test.mjs
```

39 条用例覆盖：加载期校验 fail-fast、策略投影（阈值、保留形态唯一、headroom/maxTokens 联动、按模型合并）、幂等重同步、运行时改配置与引擎重载、两条压缩触发路径、冷却与日志增量守卫、在途串行、busy/失败分类、disabled 与无引擎组合、隔离 preset 引擎解析（desktop 形态）、状态命令/空闲清扫的自愈同步、`/autocompact [percent]` 设置路径（settings 持久化、校验、引擎重同步）、状态命令。

## License

MIT
