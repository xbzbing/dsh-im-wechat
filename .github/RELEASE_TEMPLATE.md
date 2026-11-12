# Release notes template

本文件是 GitHub Release 正文的**唯一格式来源**。发版时照抄下面的骨架填写，不要翻历史 release 反推格式。

- Release 标题 = tag 名 = `v<package.json version>`；tag 由 workflow 打，**不要手工打 tag**（ADR-0020）。
- 正文**必须中英双语**：中文段在前，`---` 分隔，英文段在后；两段一一对应，不是摘要。
- 正文文件是 `docs/releases/v<version>.md`，随发版提交一起入库；workflow 校验它存在才发布，重跑时用文件覆盖页面（手工改网页会被下次重跑覆盖）。
- 两段都以 compare 链接收尾：`https://github.com/xbzbing/dsh-im-wechat/compare/<PREV>...<TAG>`，`<PREV>` 是上一个**正式版** tag（跳过 rc / alpha）；首个版本没有对比链接，写「首个版本」/ "First release"。
- 不要保留 GitHub 自动生成的 `## What's Changed` 段落。

## 写作规则

**主要变更**

- 一条一个用户可感知的结果，标题加粗，冒号后写「现在是什么样 / 为什么值得升级」，不是实现流水账。
- 顺序：面向用户的能力与修复在前，`**内部**` 类的约定 / 门禁 / 重构放最后一条。
- 不要写：版本号变更、`lib/` 重建、纯格式调整、仅测试内部改名且不改变任何保证的改动。

**验证**

- 写**当次** `npm run check` 的真实输出：单测数、打包自洽检查结果。数字不得沿用上一版。
- 再写 1–3 条最有判别力的回归：修了什么、哪条测试会在去掉修复后转红。
- 没有新验证内容时，宁可只留 `npm run check` 一行，也不要编。

**安装**

- 两条都给——npm 一条（`dsh-im-wechat@<VERSION>`）+ 同版本 GitHub Release 附件一条。
- npm 那行**钉到本版的具体版本**：这一页讲本版怎么装，`@latest` 在下一版发布会指向别的产物，与 tag / 附件对不上。
- 命令必须带 `--profile <profile>`，示例统一用 `web`。
- 预发布不发 npm：正文只给附件一条。

| 版本类型 | 中文条目数 |
| --- | --- |
| patch（修 bug / 文档） | 1–4 |
| minor（新能力） | 5–10 |

## 骨架

<!-- 从下一行开始复制 -->

## 主要变更

- **<用户可感知的标题>**：<现在是什么样、为什么值得升级>
- **修复**：<修掉的现象与影响面>
- **内部**：<约定 / 门禁 / 结构性改动>

## 安装

```bash
# 正式版（npm）
dsh plugin --profile web add dsh-im-wechat@<VERSION>

# 同一版本的 GitHub Release 附件
dsh plugin --profile web add https://github.com/xbzbing/dsh-im-wechat/releases/download/<TAG>/dsh-im-wechat-<VERSION>.tgz
```

## 验证

- `npm run check` 全绿：typecheck + <N> 单测 + 打包自洽（产物可由源码确定性重建、`files` 白名单、真实打包清单）
- <关键回归：修了什么；去掉该修复后哪条测试转红>

[完整变更记录 <PREV>...<TAG>](https://github.com/xbzbing/dsh-im-wechat/compare/<PREV>...<TAG>)

---

## English

- **<Title>**: <what it does now and why it is worth upgrading>
- **Fixes**: <the symptom and its blast radius>
- **Internal**: <conventions / gates / structural changes>

## Install

```bash
# Stable (npm)
dsh plugin --profile web add dsh-im-wechat@<VERSION>

# The same version as a GitHub Release asset
dsh plugin --profile web add https://github.com/xbzbing/dsh-im-wechat/releases/download/<TAG>/dsh-im-wechat-<VERSION>.tgz
```

## Verification

- `npm run check` green: typecheck + <N> unit tests + package self-check (artifacts reproducible from source, `files` allow-list, real packed manifest)
- <key regression: what was fixed and which test turns red without it>

[Full changelog <PREV>...<TAG>](https://github.com/xbzbing/dsh-im-wechat/compare/<PREV>...<TAG>)

<!-- 复制到上一行结束 -->

## 发布流程

```bash
# 1. 版本号：package.json 与 package-lock.json 两处 version 一起改
#    带 - 的是预发布（0.2.0-rc.1）：只打 tag + 建 GitHub 预发布，不发 npm
npm version <v> --no-git-tag-version

# 2. 正文：稳定版与预发布都要写，和版本号一起提交
$EDITOR docs/releases/v<v>.md
git add package.json package-lock.json docs/releases/v<v>.md
git commit -m "chore: release v<v>"
```

推上 master 后 workflow 自动完成：门禁 → 打 tag →（正式版）`npm publish`（可信发布，OIDC）→ GitHub Release（附同一个 tgz）。中途失败可以直接重跑（`gh workflow run release.yml`），已完成的步骤会跳过。

`lib/` 不入库：产物由 workflow 在门禁后 `npm pack` 生成，不需要也不应该提交构建产物。
