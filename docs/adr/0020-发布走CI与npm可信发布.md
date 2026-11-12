# 0020. 发布走 CI，npm 用可信发布（OIDC）

- 状态：已采纳
- 日期：2026-11-13

## 背景

首个版本发布前，发布是手工三步：本地 `npm publish`、手工 `git tag` 推送、`gh release create`。这条路在第一次发布就暴露了三件事：

1. **凭据形态不对**。发布能力挂在一个人手里的长期 npm token 上，而 npm 正在收紧这类令牌：`npm stage publish` 还能跑，`npm stage reject`、配置可信发布这类动作却要求网页 2FA，脚本走不通。风险与不便都落在同一个人身上。
2. **门禁与产物脱钩**。本地打包发出去的是「我当时工作区里的 `lib/`」，和 CI 有没有跑过、跑的是不是这份源码没有强制关系。
3. **不可重来**。tag、npm 版本、GitHub Release 三步谁先谁后没有记录，失败后只能靠人回忆补哪一步。

同时 npm 已经支持可信发布（trusted publishing）：GitHub Actions 用 OIDC 身份换取一次性发布令牌，仓库里不存任何长期 token，发布自动带来源证明（provenance）。参考 `dsh-git-panel` 的发布流水线（`.github/workflows/release.yml`）取同一套结构。

## 决策

**发布只由 `.github/workflows/release.yml` 在 master 上执行，npm 走可信发布，不存 `NPM_TOKEN`。**

1. 触发：master 上有改动到 `package.json` 的提交（即版本提交），或手动 `workflow_dispatch`。**不再手工打 tag，也不在本地 `npm publish`**。
2. 顺序：门禁（`npm ci` + `npm run check` + `npm pack` + 产物自检）→ 打 annotated tag `v<版本>` → `npm publish <tgz> --provenance --access public` → 建 GitHub Release 并挂同一个 tgz。
3. **门禁 job 与发布 job 分离**：门禁 job 要装开发依赖并执行它们的代码，所以它只读；发布 job 不 checkout、不装依赖，只从 artifact 取 tgz，独享 `contents: write` 与 `id-token: write`。供应链被污染的代码拿不到发布身份。
4. **发布正文入库**：稳定版正文是 `docs/releases/v<版本>.md`，随版本提交一起评审；缺文件就在不可逆的 `npm publish` 之前失败。重跑时用文件覆盖页面，不生成 `What's Changed`。
5. **预发布**：版本号带 `-` 时只打 tag 并建 GitHub 预发布，不发 npm。
6. 每一步先看状态再动手（tag 存在则核对 tag 里的版本、npm 已有该版本则跳过、Release 已存在则改正文），所以中途失败可以直接重跑。

## 后果

- 仓库里没有任何长期发布凭据；发布身份来自 workflow 的 OIDC，来源证明与仓库、workflow 文件绑定。
- **首次发布（0.1.0）只能人工做一次 bootstrap**：`npm trust` 的准入里明确写着「包必须已在 registry 上存在」，而从没发布过的包名配不了可信发布者。所以顺序是：先用有 2FA 的账号 `npm publish` 一次 → 把这个仓库的 `release.yml` 配成可信发布者 → 之后所有版本全走 CI。这一次发布没有来源证明，也没有走门禁流水线，写在这里以免下次以为是漏配。配好的可信发布者若 2 天内没有完成首次成功发布会自动失效，需要重新配置。
- 发布说明成了提交的一部分：想改 Release 正文就改文件，改网页会被下次重跑覆盖。
- 门禁固定 node 24：`engines` 仍写 22.19+，但 node 22 的 `node --test` 会把依赖 `AbortSignal.timeout`（定时器 unref）的直连用例判成 `cancelledByParent`，把 22 放进矩阵只会得到与产品无关的红灯。
- 代价：发布流程本身进版本库后，改它要走一次提交与门禁；本地想验证打包只能用 `npm pack` 看内容，不能直接发。
