# opencode2dsh v0.3.14

四个修复/功能，两位高质量外部贡献者的根因分析与探针数据直接驱动了其中三个。**411 项测试全绿**（0.3.13 基线 387）。

## 更新

- **修复：思考模式多步工具调用 400（[#96](https://github.com/FishBottle7/opencode2dsh/issues/96)、[#98](https://github.com/FishBottle7/opencode2dsh/issues/98)，PR [#97](https://github.com/FishBottle7/opencode2dsh/pull/97)）。** 开启 `reasoning_effort` 后，历史里一旦出现带 reasoning 的 assistant 消息，下一轮必现 `The reasoning_content in the thinking mode must be passed back`。根因：pi-ai 把上游 reasoning 字段名存进 thinking 块的 `thinkingSignature`，插件在「流 → harness 块 → 历史重建」两次转换中都把它丢了，导致回传的 assistant 消息一个 reasoning 字段都不带。修复双管齐下：签名现在完整往返（不硬编码字段名），并给 toPiModel 声明 compat 兜底——旧版插件持久化的会话历史永远没有签名，兜底把 `reasoning_content` 补成空串（字段存在即可，不需有值）。在 pi-ai 0.82.1 与 0.87.1 双版本上验证。
- **修复：接近 200k 的会话「直接报错」两连修（[#99](https://github.com/FishBottle7/opencode2dsh/issues/99)，PR [#100](https://github.com/FishBottle7/opencode2dsh/pull/100)、[#101](https://github.com/FishBottle7/opencode2dsh/pull/101)）。**
  - **上游侧**：匿名通道对 `deepseek-v4.1-flash-free` 的真实上限经带日期 needle 探针实测为 315,596 召回 / ~326k 拒绝（0.3.13 声明的 1M 来自 10-16 的旧探针，已不可复现；且上限随时间/出口漂移——一个 181.7k 的失败样本重放时已恢复）。声明窗口改为 300k，DSH 的压缩阈值（0.8×）随之回到 240k，长会话先压缩再触顶，>200k 一直可用。
  - **客户端侧**：删掉了「上游正常应答也判上下文超限」的自造错误——wire token 比宿主估算高约 4-5k（系统提示+工具 schema+序列化），200k 声明的模型接近窗口时必然误触发。真超限仍是诚实的上游 400，原文保留。
- **新增：模型白名单 `allowedModels`（[#83](https://github.com/FishBottle7/opencode2dsh/issues/83)，PR [#94](https://github.com/FishBottle7/opencode2dsh/pull/94)）。** 精确匹配模型 id 的可选配置：选择器只显示 `allowedModels ∩ 当前可用免费模型`，直接调用名单外模型在发出任何网络流量前即被拒（错误带指引）。白名单只收敛不放宽——被拉黑/探针拒绝/付费规则挡住的模型不会被白名单复活；探针也跳过名单外 id 省配额。空/缺省 = 全量行为不变。设置卡片 UI（复用 ModelPicker）见 [#95](https://github.com/FishBottle7/opencode2dsh/issues/95)，欢迎认领。

## 验证

- TypeScript 检查、构建、客户端构建干净；**411 项测试全绿**（0.3.13 基线 387，本版新增 24 项，含 #97 的双 pi-ai 版本 wire 断言、#99 的真实 adapter + 本地服务器复现矩阵、#94 的门与列表双向锁定）。
- **真机边界（诚实声明）**：#96/#99 的上游行为验证依赖本地 mock 与贡献者的真实环境（@IThanjie 本地补丁复测、@1Dreamer666 探针矩阵与 UI 截图）；维护端出口 IP 仍被上游封锁，遗留真机补验清单不变（0.3.13 发布说明所列）。上限 300k 是当前快照——该值随时间漂移，若再次变化请带日期探针数据开 issue。

## 贡献

感谢 [IThanjie](https://github.com/IThanjie)：#96 的完整根因链（pi-ai dist 逐行引用）与本地验证补丁，#98 的真实宿主回归确认；[1Dreamer666](https://github.com/1Dreamer666)：#99 的探针矩阵、上限复测与 PR #100；[kizaki-R](https://github.com/kizaki-R)：#83 的设计意见（decision 顺序与「只收敛」不变量被直接采纳）。

## 升级

需要 DSH 0.1.7 或更高版本。web profile 可执行：

```sh
dsh plugin --profile web add @opencode2dsh/dsh-plugin@0.3.14
```

安装后重启 DSH。从 0.3.12/0.3.13 升级即可消除 #88/#96/#98/#99 各症状。
