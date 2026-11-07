import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { encodeQr, qrSvg, qrSvgDataUrl } from '../../src/shared/qr.ts';
import type { QrEcc } from '../../src/shared/qr.ts';

/**
 * 参考矩阵来自公开实现（npm `qrcode`，强制字节模式）的逐格输出，只作为测试期的 oracle：
 * 每条断言比对的是整张矩阵的摘要，因此版本、纠错分块、交织、掩码选择、格式
 * 信息、版本信息、罚分规则任何一处写错都会红。oracle 不进产物、不进依赖。
 */
const FIXTURES: [name: string, ecc: QrEcc, version: number, size: number, hash: string][] = [
  ['login-url', 'L', 3, 29, '8c0945213420f503f8b8d257007d25d5'],
  ['login-url', 'M', 3, 29, 'a786879086998ecc2ff685e3520cb289'],
  ['login-url', 'Q', 4, 33, '57809c42ed130864f872bedc61d9861d'],
  ['login-url', 'H', 5, 37, '8b9c0ef59024ac1277f2e2f049fc9416'],
  ['login-long', 'L', 4, 33, '42a0d5323a0ed04743c338ddbd08c2a1'],
  ['login-long', 'M', 5, 37, '04dfd47f6c5b8fd28f67cc1f0707800f'],
  ['login-long', 'Q', 6, 41, '26f02e47c3741f9ee061307c43e978bb'],
  ['login-long', 'H', 8, 49, '4812b89443081d5a745243f483286c18'],
  ['ascii-short', 'L', 1, 21, '56bb324cb2e86a133cd29ca6f0f5d1cb'],
  ['ascii-short', 'M', 1, 21, 'e8ab680854e4019c4ac89bd0e19dfe1f'],
  ['ascii-short', 'Q', 1, 21, 'ecb9176b4e9b6282d43c9e134d23b502'],
  ['ascii-short', 'H', 1, 21, '2ade26a3126ff85bd24b873a57cf3a4c'],
  ['cjk', 'L', 3, 29, '9488d997c17026af515cf156398370bb'],
  ['cjk', 'M', 4, 33, 'bfb0dbaa75f34420d8f20db190324c23'],
  ['cjk', 'Q', 5, 37, '25b88950a984dde270d2687674a621c3'],
  ['cjk', 'H', 6, 41, 'cba26269d48f318186f9e3d89bcd9245'],
];

const TEXTS: Record<string, string> = {
  'login-url': 'https://weixin.qq.com/x/AbCdEf123456',
  'login-long': 'https://liteapp.weixin.qq.com/q/7GiQu1?qrcode=1a2b3c4d&bot_type=3',
  'ascii-short': 'a',
  cjk: '中文链接 https://weixin.qq.com/x/中文?q=1',
};

function matrixHash(code: { modules: boolean[][] }): string {
  return createHash('sha256')
    .update(code.modules.map((row) => row.map((cell) => (cell ? '1' : '0')).join('')).join('\n'))
    .digest('hex')
    .slice(0, 32);
}

for (const [name, ecc, version, size, hash] of FIXTURES) {
  test(`二维码矩阵与参考实现一致：${name}/${ecc}`, () => {
    const code = encodeQr(TEXTS[name], { ecc });
    assert.equal(code.version, version);
    assert.equal(code.size, size);
    assert.equal(matrixHash(code), hash);
  });
}

test('容量不足时抛 RangeError 而不是产出坏码', () => {
  assert.throws(() => encodeQr('x'.repeat(400), { ecc: 'H' }), RangeError);
  assert.equal(encodeQr('x'.repeat(200), { ecc: 'L' }).version, 9);
});

test('minVersion 能强制更大版本', () => {
  const small = encodeQr('a', { ecc: 'M' });
  const forced = encodeQr('a', { ecc: 'M', minVersion: 5 });
  assert.equal(small.version, 1);
  assert.equal(forced.version, 5);
  assert.equal(forced.size, 37);
});

test('SVG 尺寸与黑块数对得上', () => {
  const code = encodeQr('https://weixin.qq.com/x/abc');
  const svg = qrSvg(code, { scale: 3, margin: 4 });
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, new RegExp(`width="${(code.size + 8) * 3}"`));
  const dark = code.modules.flat().filter(Boolean).length;
  assert.equal((svg.match(/M\d+ \d+h3v3h-3z/g) ?? []).length, dark);
  const dataUrl = qrSvgDataUrl(code);
  assert.match(dataUrl, /^data:image\/svg\+xml;charset=utf-8,/);
  assert.match(decodeURIComponent(dataUrl), /^data:image\/svg\+xml;charset=utf-8,<svg/);
});
