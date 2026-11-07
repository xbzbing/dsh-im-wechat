/**
 * 二维码编码器（零依赖，字节模式）。
 *
 * 为什么要自己写：登录二维码里编码的是 `qrcode_img_content`（协议给的是**待编码
 * 文本**，不是图片，ADR-0002），面板要在浏览器里把它画出来，而仓库约定零运行时
 * 依赖。
 *
 * 只实现到版本 10、字节模式、四级纠错——扫码登录的链接只有一两百字节，版本 10
 * 的字节容量（约 270 字节）够用；再大就该换设计而不是加表。
 *
 * 正确性由单测钉住：用公开实现（仅测试期作为 oracle，不进产物）生成同一段文本的
 * 模块矩阵，逐格比对。掩码选择按标准的四条罚分规则，所以选出的掩码也必须一致。
 */

import { ALIGNMENT_POSITIONS, ECC_FORMAT_BITS, ECC_TABLE, MAX_VERSION } from './qr-tables.ts';
import type { QrEcc } from './qr-tables.ts';

export type { QrEcc };

export interface QrCode {
  version: number;
  /** 边长（模块数，不含静区）。 */
  size: number;
  /** `modules[row][col]`，true 为黑。 */
  modules: boolean[][];
}

// ---------------------------------------------------------------- GF(256) 与 RS

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);

(function initGaloisField(): void {
  let value = 1;
  for (let index = 0; index < 255; index += 1) {
    GF_EXP[index] = value;
    GF_LOG[value] = index;
    value <<= 1;
    if (value & 0x100) value ^= 0x11d;
  }
  for (let index = 255; index < 512; index += 1) GF_EXP[index] = GF_EXP[index - 255];
})();

function gfMultiply(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

/** 生成多项式 `(x - α^0)…(x - α^(degree-1))`，首项系数为 1。 */
function generatorPolynomial(degree: number): number[] {
  let polynomial = [1];
  for (let index = 0; index < degree; index += 1) {
    const next = new Array<number>(polynomial.length + 1).fill(0);
    for (let at = 0; at < polynomial.length; at += 1) {
      next[at] ^= polynomial[at];
      next[at + 1] ^= gfMultiply(polynomial[at], GF_EXP[index]);
    }
    polynomial = next;
  }
  return polynomial;
}

/** 计算纠错码字：`data * x^degree mod generator`。 */
function reedSolomonRemainder(data: ArrayLike<number>, degree: number): number[] {
  const generator = generatorPolynomial(degree);
  const remainder = new Array<number>(degree).fill(0);
  for (let at = 0; at < data.length; at += 1) {
    const factor = data[at] ^ remainder[0];
    remainder.shift();
    remainder.push(0);
    if (factor !== 0) {
      for (let index = 0; index < degree; index += 1) {
        remainder[index] ^= gfMultiply(generator[index + 1], factor);
      }
    }
  }
  return remainder;
}

// ---------------------------------------------------------------- 数据编码

/** 追加若干位（高位在前）到一个位数组。 */
function pushBits(bits: number[], value: number, length: number): void {
  for (let shift = length - 1; shift >= 0; shift -= 1) bits.push((value >>> shift) & 1);
}

function countBitsFor(version: number): number {
  return version <= 9 ? 8 : 16;
}

function dataCodewordCount(version: number, ecc: QrEcc): number {
  return ECC_TABLE[version][ecc].groups.reduce((sum, [blocks, perBlock]) => sum + blocks * perBlock, 0);
}

function pickVersion(byteLength: number, ecc: QrEcc, minVersion: number): number {
  for (let version = Math.max(1, minVersion); version <= MAX_VERSION; version += 1) {
    const capacityBits = dataCodewordCount(version, ecc) * 8;
    const neededBits = 4 + countBitsFor(version) + byteLength * 8;
    if (neededBits <= capacityBits) return version;
  }
  throw new RangeError(`内容太长：${byteLength} 字节超出二维码版本 ${MAX_VERSION} 的容量`);
}

/** 字节模式编码 + 补齐到数据码字。 */
function encodeData(bytes: Uint8Array, version: number, ecc: QrEcc): number[] {
  const bits: number[] = [];
  pushBits(bits, 0b0100, 4);
  pushBits(bits, bytes.length, countBitsFor(version));
  for (const byte of bytes) pushBits(bits, byte, 8);

  const capacityBits = dataCodewordCount(version, ecc) * 8;
  pushBits(bits, 0, Math.min(4, capacityBits - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);

  const codewords: number[] = [];
  for (let at = 0; at < bits.length; at += 8) {
    let value = 0;
    for (let index = 0; index < 8; index += 1) value = (value << 1) | bits[at + index];
    codewords.push(value);
  }
  for (let pad = 0xec; codewords.length < capacityBits / 8; pad ^= 0xec ^ 0x11) {
    codewords.push(pad);
  }
  return codewords;
}

/** 分块算纠错码，再按标准交织（数据在前、纠错在后）。 */
function interleave(codewords: number[], version: number, ecc: QrEcc): number[] {
  const spec = ECC_TABLE[version][ecc];
  const blocks: number[][] = [];
  let offset = 0;
  for (const [count, perBlock] of spec.groups) {
    for (let index = 0; index < count; index += 1) {
      blocks.push(codewords.slice(offset, offset + perBlock));
      offset += perBlock;
    }
  }
  const eccBlocks = blocks.map((block) => reedSolomonRemainder(block, spec.ec));

  const result: number[] = [];
  const maxDataLength = Math.max(...blocks.map((block) => block.length));
  for (let at = 0; at < maxDataLength; at += 1) {
    for (const block of blocks) {
      if (at < block.length) result.push(block[at]);
    }
  }
  for (let at = 0; at < spec.ec; at += 1) {
    for (const block of eccBlocks) result.push(block[at]);
  }
  return result;
}

// ---------------------------------------------------------------- 矩阵

interface Matrix {
  size: number;
  modules: boolean[][];
  isFunction: boolean[][];
}

function createMatrix(size: number): Matrix {
  return {
    size,
    modules: Array.from({ length: size }, () => new Array<boolean>(size).fill(false)),
    isFunction: Array.from({ length: size }, () => new Array<boolean>(size).fill(false)),
  };
}

function setFunction(matrix: Matrix, row: number, col: number, dark: boolean): void {
  matrix.modules[row][col] = dark;
  matrix.isFunction[row][col] = true;
}

/** 三个角上的定位图案（含分隔带）。 */
function drawFinderPatterns(matrix: Matrix): void {
  const corners: [number, number][] = [[0, 0], [0, matrix.size - 7], [matrix.size - 7, 0]];
  for (const [row, col] of corners) {
    for (let dy = -1; dy <= 7; dy += 1) {
      for (let dx = -1; dx <= 7; dx += 1) {
        const y = row + dy;
        const x = col + dx;
        if (y < 0 || y >= matrix.size || x < 0 || x >= matrix.size) continue;
        const inRing = dy >= 0 && dy <= 6 && dx >= 0 && dx <= 6;
        const dark = inRing && (dy === 0 || dy === 6 || dx === 0 || dx === 6
          || (dy >= 2 && dy <= 4 && dx >= 2 && dx <= 4));
        setFunction(matrix, y, x, dark);
      }
    }
  }
}

/** 定时图案：第 6 行与第 6 列的交替模块。 */
function drawTimingPatterns(matrix: Matrix): void {
  for (let at = 8; at < matrix.size - 8; at += 1) {
    const dark = at % 2 === 0;
    if (!matrix.isFunction[6][at]) setFunction(matrix, 6, at, dark);
    if (!matrix.isFunction[at][6]) setFunction(matrix, at, 6, dark);
  }
}

/** 校准图案：避开三个定位图案的位置。 */
function drawAlignmentPatterns(matrix: Matrix, version: number): void {
  const positions = ALIGNMENT_POSITIONS[version] ?? [];
  const last = positions.length - 1;
  for (let rowIndex = 0; rowIndex < positions.length; rowIndex += 1) {
    for (let colIndex = 0; colIndex < positions.length; colIndex += 1) {
      const overlapsFinder = (rowIndex === 0 && colIndex === 0)
        || (rowIndex === 0 && colIndex === last)
        || (rowIndex === last && colIndex === 0);
      if (overlapsFinder) continue;
      const row = positions[rowIndex];
      const col = positions[colIndex];
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          const dark = Math.max(Math.abs(dy), Math.abs(dx)) !== 1;
          setFunction(matrix, row + dy, col + dx, dark);
        }
      }
    }
  }
}

/** 预留格式信息与版本信息的位置（先占位，掩码选完再写真实值）。 */
function reserveFormatAreas(matrix: Matrix, version: number): void {
  const size = matrix.size;
  for (let at = 0; at <= 8; at += 1) {
    if (!matrix.isFunction[at][8]) setFunction(matrix, at, 8, false);
    if (!matrix.isFunction[8][at]) setFunction(matrix, 8, at, false);
  }
  for (let at = 0; at < 8; at += 1) {
    if (!matrix.isFunction[8][size - 1 - at]) setFunction(matrix, 8, size - 1 - at, false);
    if (!matrix.isFunction[size - 1 - at][8]) setFunction(matrix, size - 1 - at, 8, false);
  }
  if (version >= 7) {
    for (let at = 0; at < 18; at += 1) {
      const a = size - 11 + (at % 3);
      const b = Math.floor(at / 3);
      if (!matrix.isFunction[b][a]) setFunction(matrix, b, a, false);
      if (!matrix.isFunction[a][b]) setFunction(matrix, a, b, false);
    }
  }
}

/** 数据按「从右下角向上、两列一组」的蛇形填进去。 */
function drawData(matrix: Matrix, codewords: number[]): void {
  const bits = codewords.flatMap((byte) => [byte >>> 7, (byte >>> 6) & 1, (byte >>> 5) & 1, (byte >>> 4) & 1,
    (byte >>> 3) & 1, (byte >>> 2) & 1, (byte >>> 1) & 1, byte & 1]);
  let bitIndex = 0;
  let upward = true;
  for (let right = matrix.size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vertical = 0; vertical < matrix.size; vertical += 1) {
      const row = upward ? matrix.size - 1 - vertical : vertical;
      for (let offset = 0; offset < 2; offset += 1) {
        const col = right - offset;
        if (matrix.isFunction[row][col]) continue;
        matrix.modules[row][col] = bitIndex < bits.length ? bits[bitIndex] === 1 : false;
        bitIndex += 1;
      }
    }
    upward = !upward;
  }
}

function maskBit(mask: number, row: number, col: number): boolean {
  switch (mask) {
    case 0: return (row + col) % 2 === 0;
    case 1: return row % 2 === 0;
    case 2: return col % 3 === 0;
    case 3: return (row + col) % 3 === 0;
    case 4: return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
    case 5: return ((row * col) % 2) + ((row * col) % 3) === 0;
    case 6: return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
    default: return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0;
  }
}

function applyMask(matrix: Matrix, mask: number): void {
  for (let row = 0; row < matrix.size; row += 1) {
    for (let col = 0; col < matrix.size; col += 1) {
      if (!matrix.isFunction[row][col] && maskBit(mask, row, col)) {
        matrix.modules[row][col] = !matrix.modules[row][col];
      }
    }
  }
}

function bchRemainder(value: number, polynomial: number, degree: number): number {
  let remainder = value;
  for (let at = degree; at >= 0; at -= 1) {
    if ((remainder >>> (at + 10)) & 1) remainder ^= polynomial << at;
  }
  return remainder;
}

/** 15 位格式信息：2 位纠错级别 + 3 位掩码 + BCH 校验，最后异或固定值。 */
function formatBits(ecc: QrEcc, mask: number): number {
  const data = (ECC_FORMAT_BITS[ecc] << 3) | mask;
  const remainder = bchRemainder(data << 10, 0x537, 4);
  return ((data << 10) | remainder) ^ 0x5412;
}

function drawFormat(matrix: Matrix, ecc: QrEcc, mask: number): void {
  const bits = formatBits(ecc, mask);
  const size = matrix.size;
  const bit = (index: number): boolean => ((bits >>> index) & 1) === 1;
  for (let at = 0; at <= 5; at += 1) setFunction(matrix, at, 8, bit(at));
  setFunction(matrix, 7, 8, bit(6));
  setFunction(matrix, 8, 8, bit(7));
  setFunction(matrix, 8, 7, bit(8));
  for (let at = 9; at < 15; at += 1) setFunction(matrix, 8, 14 - at, bit(at));
  for (let at = 0; at < 8; at += 1) setFunction(matrix, 8, size - 1 - at, bit(at));
  for (let at = 8; at < 15; at += 1) setFunction(matrix, size - 15 + at, 8, bit(at));
  // 固定的黑模块。
  setFunction(matrix, size - 8, 8, true);
}

function drawVersionInfo(matrix: Matrix, version: number): void {
  if (version < 7) return;
  let remainder = version;
  for (let at = 0; at < 12; at += 1) {
    remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
  }
  const bits = (version << 12) | remainder;
  for (let at = 0; at < 18; at += 1) {
    const dark = ((bits >>> at) & 1) === 1;
    const a = matrix.size - 11 + (at % 3);
    const b = Math.floor(at / 3);
    setFunction(matrix, b, a, dark);
    setFunction(matrix, a, b, dark);
  }
}

// ---------------------------------------------------------------- 罚分

function penalty(matrix: Matrix): number {
  const size = matrix.size;
  let score = 0;

  // 规则 1：行/列上连续 5 个以上同色。
  for (let row = 0; row < size; row += 1) {
    let runLength = 1;
    for (let col = 1; col < size; col += 1) {
      if (matrix.modules[row][col] === matrix.modules[row][col - 1]) {
        runLength += 1;
      } else {
        if (runLength >= 5) score += 3 + (runLength - 5);
        runLength = 1;
      }
    }
    if (runLength >= 5) score += 3 + (runLength - 5);
  }
  for (let col = 0; col < size; col += 1) {
    let runLength = 1;
    for (let row = 1; row < size; row += 1) {
      if (matrix.modules[row][col] === matrix.modules[row - 1][col]) {
        runLength += 1;
      } else {
        if (runLength >= 5) score += 3 + (runLength - 5);
        runLength = 1;
      }
    }
    if (runLength >= 5) score += 3 + (runLength - 5);
  }

  // 规则 2：2x2 同色块。
  for (let row = 0; row < size - 1; row += 1) {
    for (let col = 0; col < size - 1; col += 1) {
      const color = matrix.modules[row][col];
      if (color === matrix.modules[row][col + 1]
        && color === matrix.modules[row + 1][col]
        && color === matrix.modules[row + 1][col + 1]) {
        score += 3;
      }
    }
  }

  // 规则 3：1:1:3:1:1 的定位图案前后带 4 个白模块；按 11 位窗口匹配。
  const FINDER_A = 0x5d0; // 10111010000
  const FINDER_B = 0x05d; // 00001011101
  for (let line = 0; line < size; line += 1) {
    let rowBits = 0;
    let colBits = 0;
    for (let at = 0; at < size; at += 1) {
      rowBits = ((rowBits << 1) & 0x7ff) | (matrix.modules[line][at] ? 1 : 0);
      colBits = ((colBits << 1) & 0x7ff) | (matrix.modules[at][line] ? 1 : 0);
      if (at >= 10 && (rowBits === FINDER_A || rowBits === FINDER_B)) score += 40;
      if (at >= 10 && (colBits === FINDER_A || colBits === FINDER_B)) score += 40;
    }
  }

  // 规则 4：黑色占比偏离 50%。
  let dark = 0;
  for (const line of matrix.modules) {
    for (const cell of line) if (cell) dark += 1;
  }
  // 与标准一致：以 5% 为步长向上取整后再比 50%。
  const steps = Math.abs(Math.ceil((dark * 100) / (size * size) / 5) - 10);
  score += steps * 10;
  return score;
}

// ---------------------------------------------------------------- 对外

export interface QrOptions {
  ecc?: QrEcc;
  /** 强制最低版本（测试与版面用）。 */
  minVersion?: number;
}

/** 把文本编码成二维码模块矩阵。 */
export function encodeQr(text: string, options: QrOptions = {}): QrCode {
  const ecc = options.ecc ?? 'M';
  const bytes = new TextEncoder().encode(text);
  const version = pickVersion(bytes.length, ecc, options.minVersion ?? 1);
  const codewords = interleave(encodeData(bytes, version, ecc), version, ecc);

  const size = 17 + 4 * version;
  const template = createMatrix(size);
  drawFinderPatterns(template);
  drawTimingPatterns(template);
  drawAlignmentPatterns(template, version);
  reserveFormatAreas(template, version);
  drawData(template, codewords);
  drawVersionInfo(template, version);

  let best: Matrix | null = null;
  let bestMask = 0;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < 8; mask += 1) {
    const candidate = createMatrix(size);
    for (let row = 0; row < size; row += 1) {
      candidate.modules[row] = [...template.modules[row]];
      candidate.isFunction[row] = [...template.isFunction[row]];
    }
    applyMask(candidate, mask);
    drawFormat(candidate, ecc, mask);
    const score = penalty(candidate);
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
      bestMask = mask;
    }
  }

  const chosen = best ?? template;
  drawFormat(chosen, ecc, bestMask);
  return { version, size, modules: chosen.modules };
}

/**
 * 二维码的 SVG（不含静区，`scale` 是每模块的像素数）。
 *
 * 用 `path` 一次画完所有黑块：比几百个 `rect` 小得多，面板里当 data URL 用。
 */
export function qrSvg(code: QrCode, options: { scale?: number; margin?: number } = {}): string {
  const scale = options.scale ?? 4;
  const margin = options.margin ?? 4;
  const dimension = (code.size + margin * 2) * scale;
  const commands: string[] = [];
  for (let row = 0; row < code.size; row += 1) {
    for (let col = 0; col < code.size; col += 1) {
      if (!code.modules[row][col]) continue;
      commands.push(`M${(col + margin) * scale} ${(row + margin) * scale}h${scale}v${scale}h-${scale}z`);
    }
  }
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${dimension}" height="${dimension}"`,
    ` viewBox="0 0 ${dimension} ${dimension}" shape-rendering="crispEdges">`,
    `<rect width="100%" height="100%" fill="#ffffff"/>`,
    `<path d="${commands.join('')}" fill="#000000"/>`,
    '</svg>',
  ].join('');
}

/** 面板 `<img src>` 用的 data URL。 */
export function qrSvgDataUrl(code: QrCode, options?: { scale?: number; margin?: number }): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(qrSvg(code, options))}`;
}
