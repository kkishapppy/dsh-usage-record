# dsh-usage-record

DSH Web 对话区**左侧提问导航轨**：每条横线 = 一次提问，点击即跳转到对应位置，支持鱼眼放大、滚动跟随、后台全量预加载。

## 功能

- **会话自动标题**：包装 `sessionPersistence.list()`，给会话列表每行补 `title` —— 取该会话**最后一次真实提问**的摘要（≤30 字；最后一条太短（<8 字，如「好的」「1」）自动与更早一条合并）。**离开后固化**：对话进行中标题保持稳定（显示上次固化结果，不随每句话跳动），会话闲置 ≥ 30 分钟（`titleIdleMinutes` 可配）才生成/更新标题并落盘。纯规则 + 内存缓存 + 单定时器，不调 LLM、不联网；手动命名覆盖表 `dataDir/titles.json`（默认 `E:\DeepSeekHarness\data\usage-record\titles.json`，`{ "session-xxxx…": "我给的名字" }`）优先级最高，外部行自带 title 时不动。
- **提问导航轨**：对话左侧竖轨，每条横线代表一次提问，悬停显示提问内容 tooltip
- **点击跳转**：点击横线 → 聊天区平滑滚动到该提问（未渲染的历史自动加载后再跳）
- **鱼眼效果**：鼠标移动时横线按距离放大（σ=10），边缘留白防裁剪
- **滚动跟随（scroll-spy）**：当前视口中心的提问在轨道上高亮；聊天滚动时轨道自动跟随
- **后台预加载**：轨道可见即自动批量加载全部历史提问（配合 history 批量补丁，长会话秒跳）
- 全部数据来自服务端 `/plugins/dsh-usage-record/questions`（从会话日志提取，不受聊天虚拟化窗口限制）

## 安装

```bash
dsh plugin --profile web add dsh-usage-record
```

配置（`profiles/<profile>/cordis.patch.yml`，可选）：

```yaml
- id: usage-record
  config:
    dataDir: 'E:\DeepSeekHarness\data\usage-record'   # 默认 <cwd>/data/usage-record
```

## 已知依赖与限制

- 依赖 DSH Web 客户端内部 DOM 结构（`[data-chat-flow]`、`[data-chat-anchor-key]`、滚动容器等），**随 DSH 版本升级可能失效**（社区客户端插件的共性）
- `history RPC` 批量被放大到 3000（官方默认 50），位于客户端源码 `HISTORY_BATCH` 常量，可按需调整
- 轨道仅在会话视图渲染；需要会话存在历史提问

## 开发

```bash
npm i
npx -y tsdown@0.22.2 --config ./tsdown.config.ts
# 服务端改动需重启 DSH；client 改动硬刷新页面即生效
```

## License

MIT
