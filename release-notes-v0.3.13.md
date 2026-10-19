# opencode2dsh v0.3.13

本版集中处理 2026-10-15 起上游新一轮风控（[#72](https://github.com/FishBottle7/opencode2dsh/issues/72) 一族），以及一个影响所有 hoisted 安装的静默工具丢失 bug。共合并 7 个 PR，新增 91 项测试。

## 更新

- **免费通道请求形状跟随新风控（[#80](https://github.com/FishBottle7/opencode2dsh/pull/80)，修 #72/#88）。** 端点迁至 `/inference`；不再发送 `x-opencode-request`（任何值都会被拒）；`x-opencode-project` 固定 `global`（`prj_` 前缀会触发 403）；新增 `x-opencode-session-id`；注入的 `bash`/`read` 门禁工具携带真实 schema（空 schema 壳会被替换而非算作满足）。上述形状由 #74/#75/#78 三份独立实测互相印证。
- **间歇性 403 增加姊妹主机重放（#80）。** 实测该拒绝是间歇性的（同一请求 22 分钟内先后 403 与 200）：内容尚未送出的一次 401/403 会在 `/inference` ↔ `/zen` 之间重放一次，仍受既有轮换上限约束；第二次被拒则诚实报错。注意：整段出口 IP 被上游标记（错误文案明确写 abusive traffic from this IP）时两主机会同时拒，重试无法绕过——换网络或等解封。
- **修复 pi-ai ≥ 0.86 下宿主工具静默丢失（[#91](https://github.com/FishBottle7/opencode2dsh/pull/91)，修 #77）。** pi-ai 0.86.0 起把工具声明折叠进 `TranscriptContext`，只在其 Models 入口发生；适配器直调原始 provider，导致 DSH profile（hoisted 解析 0.87.x）下模型收不到 `read`/`grep` 等宿主工具，只能输出工具调用语法文本。现在统一走 Models 包装，0.82.x 与 ≥0.86 双版本实测工具完整上 wire。
- **IP 池：订阅池真正可用 + 失败按成因分级（[#70](https://github.com/FishBottle7/opencode2dsh/pull/70)、[#87](https://github.com/FishBottle7/opencode2dsh/pull/87)）。** 纯订阅池现在会在首个出口准入时自动启用路由与周期性复探（此前路由与探测都不启动）；探测失败按成因分类（transport/refused/server-error/quota/geo-blocked/slow/malformed），只有 transport 才判死，不再把「模型拒绝」误判成「链路死亡」；`https://` 代理不再被当明文拨号打死（端到端协议保真，46/118 误杀场景实测修复）；调度器哨兵不再把真实传输错误吞成合成静默错误（确定性双注入 bug，修复带阴性对照测试）。
- **被拉黑模型按本机出口自适应复核（[#84](https://github.com/FishBottle7/opencode2dsh/pull/84)，修 #82）。** #56 拉黑的 `exo-free`、`ling-3.0-flash-fin-free`、`muse-spark-1.2/1.3-contributor-free` 现在每 30 分钟从本机出口发一次 1-token 探测，通过即重新出现在选择器；`jev-1.13-free` 维持永久拉黑（协议级 400）。
- **`deepseek-v4.1-flash-free` 上下文窗口修正为 1M（[#86](https://github.com/FishBottle7/opencode2dsh/pull/86)，修 #81）。** models.dev 声明 200000，needle 实测 1,011,668 token 仍有召回；走与 #56 mimo 相同的本地覆盖机制。
- **新增（默认关闭）：本地 OpenCode 委托（[#92](https://github.com/FishBottle7/opencode2dsh/pull/92)，ref [#76](https://github.com/FishBottle7/opencode2dsh/issues/76)）。** #76 实测新风控门槛是凭据（auth.json 的 `oc_sk_`）而非请求形状。开启 `delegation.enabled` 后，匿名通道持续性 FreeTierError（直连 + 姊妹重放均 403）时该轮改由本地真实 `opencode serve` 子进程完成：只拷贝 `opencode` 条目到隔离 XDG（0600，值永不落日志）、二进制版本下限 1.18.0（managed → 全局 → npm 下载，sha512 校验）、内存受控、所有本地工具调用 ask-then-reject 中介（绝不在你机器上执行任何东西）。**开启即意味着插件托管你的凭据，且代理个人凭据存在账号层面的风险，详见 `docs/delegation.md`，默认路径零变化。**

## 验证

- TypeScript 检查、构建、客户端构建干净；**387 项测试全绿**（0.3.12 基线 296，本版累计新增 91 项，含 #87 修复的确定性阴性对照、#91 的双 pi-ai 版本真包验证、#92 的 mock `opencode serve` 端到端 28 项）。
- **真机（2026-10-19，issue50 profile）**：姊妹主机重试在 chat 与 Responses 双路径实机触发并按设计工作；`/inference/v1/models` 正常返回 85 模型。
- **真机边界（诚实声明）**：#80 形状被接受（生成 200）有 PR 作者 10-15 被墙前的真机证据，但本机出口自 10-19 起 IP 级封锁，无法本机复现；#84 探针的 pass 分支、#70/#87 的真实代理池行为、#92 的活体 opencode 协议待出口可用后补验（协议形状移植自 MIT 参考实现，#92 默认关闭不影响默认路径）。

## 贡献

感谢 [kizaki-R](https://github.com/kizaki-R)：#80 的形状整合与姊妹重试、#84 的自适应探测设计；[ftf112233](https://github.com/ftf112233)：#86 上下文窗与 #87 哨兵竞争修复（后者经复核实为确定性双注入，比报告更强）；[GT-610](https://github.com/GT-610)：#70 订阅池健康体系大修；[reisen-ww](https://github.com/reisen-ww)：#76 的 A/B 实测、委托方案设计与 opengate 参考实现（#92 以 MIT 引用移植）；[BobJu0721](https://github.com/BobJu0721)：#74 的测量。以及 #72/#73/#75/#78/#81/#82 各位的报告与数据。

## 升级

需要 DSH 0.1.7 或更高版本。web profile 可执行：

```sh
dsh plugin --profile web add @opencode2dsh/dsh-plugin@0.3.13
```

安装后重启 DSH。
