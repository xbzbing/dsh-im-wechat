#!/usr/bin/env node
/**
 * 真机自测脚本（开发用，不随包发布）。
 *
 * 两件事：
 * 1. `node scripts/dev-bridge.mjs login` —— 取二维码并在终端画出来（用半块字符，
 *    手机直接扫），等到扫码确认后把登录态落盘；
 * 2. `node scripts/dev-bridge.mjs run` —— 起长轮询，把收到的主人文案打印出来，
 *    并对 `ping` 回 `pong`（走真实的 sendmessage，验证 context_token 链路）。
 *
 * 它复用 `src/` 的实现而不是另写一套，因此脚本通过就意味着协议层可用。
 */

import process from 'node:process';

import { createApi, DEFAULT_BASE_URL } from '../src/host/ilink/api.ts';
import { LoginController } from '../src/host/ilink/login.ts';
import { PollLoop } from '../src/host/ilink/poll.ts';
import { SessionGuard } from '../src/host/ilink/session-guard.ts';
import { sendText } from '../src/host/ilink/send.ts';
import { ContextTokenStore } from '../src/host/state/context-tokens.ts';
import { LoginStateStore, accountTail } from '../src/host/state/login-state.ts';
import { resolveDataDir } from '../src/host/state/paths.ts';
import { SyncCursorStore } from '../src/host/state/sync-cursor.ts';
import { encodeQr } from '../src/shared/qr.ts';
import { PLUGIN_VERSION } from '../src/shared/version.ts';

const dir = resolveDataDir();
const loginStore = new LoginStateStore({ dir });
const cursorStore = new SyncCursorStore({ dir });
const tokenStore = new ContextTokenStore({ dir });
const guard = new SessionGuard();
const logger = {
  info: (...args) => process.stderr.write(`[info] ${args.join(' ')}\n`),
  warn: (...args) => process.stderr.write(`[warn] ${args.join(' ')}\n`),
  error: (...args) => process.stderr.write(`[error] ${args.join(' ')}\n`),
};

function makeApi(token) {
  return createApi({
    baseUrl: stateBaseUrl,
    ...(token ? { token } : {}),
    channelVersion: PLUGIN_VERSION,
    botAgent: `dsh-im-wechat/${PLUGIN_VERSION}`,
  });
}

let stateBaseUrl = DEFAULT_BASE_URL;

/** 半块字符画二维码：两行并一行，手机能直接扫。 */
function printQr(content) {
  let code;
  try {
    code = encodeQr(content, { ecc: 'M' });
  } catch (error) {
    process.stdout.write(`（无法生成二维码：${error.message}）\n${content}\n`);
    return;
  }
  const quiet = 2;
  const dark = (row, col) => {
    const r = row - quiet;
    const c = col - quiet;
    if (r < 0 || c < 0 || r >= code.size || c >= code.size) return false;
    return code.modules[r][c];
  };
  const lines = [];
  for (let row = 0; row < code.size + quiet * 2; row += 2) {
    let line = '';
    for (let col = 0; col < code.size + quiet * 2; col += 1) {
      const top = dark(row, col);
      const bottom = dark(row + 1, col);
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
    }
    lines.push(line);
  }
  process.stdout.write(`\n${lines.join('\n')}\n\n`);
  process.stdout.write(`若二维码不可用，可在手机微信里打开：\n${content}\n\n`);
}

async function login() {
  const controller = new LoginController({
    apiFactory: (baseUrl) => {
      stateBaseUrl = baseUrl;
      return makeApi(undefined);
    },
    store: loginStore,
    logger,
    onConfirmed: (state) => {
      process.stdout.write(`\n登录成功：${accountTail(state.account)}（${state.baseUrl}）\n`);
    },
  });
  const snapshot = await controller.start();
  if (snapshot.qrContent) printQr(snapshot.qrContent);
  if (snapshot.phase === 'failed') {
    process.stderr.write(`取二维码失败：${snapshot.error ?? ''}\n`);
    process.exitCode = 1;
    return;
  }
  let printedPhase = '';
  const watcher = setInterval(() => {
    const now = controller.snapshot();
    if (now.phase !== printedPhase) {
      printedPhase = now.phase;
      if (now.phase === 'scanned') process.stdout.write('已扫描，请在手机上确认…\n');
      if (now.phase === 'need-verify-code') {
        process.stdout.write('请输入手机微信显示的数字：');
        process.stdin.setEncoding('utf-8');
        process.stdin.once('data', (chunk) => controller.submitVerifyCode(String(chunk).trim()));
      }
    }
  }, 500);
  await controller.waitForSettled();
  clearInterval(watcher);
  const final = controller.snapshot();
  if (final.phase !== 'confirmed') {
    process.stderr.write(`登录未完成：${final.phase} ${final.error ?? ''}\n`);
    process.exitCode = 1;
  }
}

async function run() {
  const state = await loginStore.load();
  if (!state) {
    process.stderr.write('还没有登录态，先跑：node scripts/dev-bridge.mjs login\n');
    process.exitCode = 1;
    return;
  }
  stateBaseUrl = state.baseUrl;
  const api = makeApi(state.botToken);
  await tokenStore.hydrate(state.account);
  const abort = new AbortController();
  process.on('SIGINT', () => abort.abort());
  process.stdout.write(`已连接 ${accountTail(state.account)}，等待微信消息（Ctrl+C 退出）…\n`);
  await api.notifyStart().catch(() => undefined);

  const loop = new PollLoop({
    api,
    account: state.account,
    cursor: cursorStore,
    contextTokens: tokenStore,
    guard,
    logger,
    onHealth: (health) => {
      if (health.state !== 'ok') process.stderr.write(`[health] ${health.state} ${health.code ?? ''} ${health.reason ?? ''}\n`);
    },
    onMessage: async (message) => {
      const text = (message.item_list ?? [])
        .map((item) => item?.text_item?.text ?? (item?.type === 2 ? '[图片]' : ''))
        .filter(Boolean)
        .join(' ');
      const types = (message.item_list ?? []).map((item) => item?.type).join(',');
      process.stdout.write(`← ${message.from_user_id}（types=${types}）：${text}\n`);
      if (text.trim() === 'ping') {
        const token = tokenStore.get(state.account, message.from_user_id ?? '');
        try {
          await sendText(api, { to: message.from_user_id ?? '', text: 'pong（dsh-im-wechat 自测）', contextToken: token });
          process.stdout.write('→ 已回复 pong\n');
        } catch (error) {
          process.stderr.write(`→ 回复失败：${error.message}\n`);
        }
      }
    },
  });
  await loop.run(abort.signal);
  await api.notifyStop().catch(() => undefined);
}

const command = process.argv[2] ?? 'login';
if (command === 'login') await login();
else if (command === 'run') await run();
else {
  process.stderr.write('用法：node scripts/dev-bridge.mjs [login|run]\n');
  process.exitCode = 1;
}
