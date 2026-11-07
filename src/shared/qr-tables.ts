/**
 * 二维码的静态参数（ISO/IEC 18004 表 9 与校准图案表）。
 *
 * 只覆盖版本 1–10：扫码登录链接不到 200 字节，版本 10 的字节容量（约 270 字节）
 * 足够；需要更大版本时应当重新评估方案而不是无脑加表。
 */

export type QrEcc = 'L' | 'M' | 'Q' | 'H';

/** 版本上限：表只覆盖到这里。 */
export const MAX_VERSION = 10;

interface EccSpec {
  /** 每块纠错码字数。 */
  ec: number;
  /** [块数, 每块数据码字数] 分组。 */
  groups: [number, number][];
}

/** 版本 1–10 的纠错参数（ISO/IEC 18004 表 9）。 */
export const ECC_TABLE: Record<number, Record<QrEcc, EccSpec>> = {
  1: { L: { ec: 7, groups: [[1, 19]] }, M: { ec: 10, groups: [[1, 16]] }, Q: { ec: 13, groups: [[1, 13]] }, H: { ec: 17, groups: [[1, 9]] } },
  2: { L: { ec: 10, groups: [[1, 34]] }, M: { ec: 16, groups: [[1, 28]] }, Q: { ec: 22, groups: [[1, 22]] }, H: { ec: 28, groups: [[1, 16]] } },
  3: { L: { ec: 15, groups: [[1, 55]] }, M: { ec: 26, groups: [[1, 44]] }, Q: { ec: 18, groups: [[2, 17]] }, H: { ec: 22, groups: [[2, 13]] } },
  4: { L: { ec: 20, groups: [[1, 80]] }, M: { ec: 18, groups: [[2, 32]] }, Q: { ec: 26, groups: [[2, 24]] }, H: { ec: 16, groups: [[4, 9]] } },
  5: { L: { ec: 26, groups: [[1, 108]] }, M: { ec: 24, groups: [[2, 43]] }, Q: { ec: 18, groups: [[2, 15], [2, 16]] }, H: { ec: 22, groups: [[2, 11], [2, 12]] } },
  6: { L: { ec: 18, groups: [[2, 68]] }, M: { ec: 16, groups: [[4, 27]] }, Q: { ec: 24, groups: [[4, 19]] }, H: { ec: 28, groups: [[4, 15]] } },
  7: { L: { ec: 20, groups: [[2, 78]] }, M: { ec: 18, groups: [[4, 31]] }, Q: { ec: 18, groups: [[2, 14], [4, 15]] }, H: { ec: 26, groups: [[4, 13], [1, 14]] } },
  8: { L: { ec: 24, groups: [[2, 97]] }, M: { ec: 22, groups: [[2, 38], [2, 39]] }, Q: { ec: 22, groups: [[4, 18], [2, 19]] }, H: { ec: 26, groups: [[4, 14], [2, 15]] } },
  9: { L: { ec: 30, groups: [[2, 116]] }, M: { ec: 22, groups: [[3, 36], [2, 37]] }, Q: { ec: 20, groups: [[4, 16], [4, 17]] }, H: { ec: 24, groups: [[4, 12], [4, 13]] } },
  10: { L: { ec: 18, groups: [[2, 68], [2, 69]] }, M: { ec: 26, groups: [[4, 43], [1, 44]] }, Q: { ec: 24, groups: [[6, 19], [2, 20]] }, H: { ec: 28, groups: [[6, 15], [2, 16]] } },
};

/** 校准图案中心坐标（版本 1 无校准图案）。 */
export const ALIGNMENT_POSITIONS: Record<number, number[]> = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
};

/** 纠错级别在格式信息里的两位编码。 */
export const ECC_FORMAT_BITS: Record<QrEcc, number> = { L: 1, M: 0, Q: 3, H: 2 };

