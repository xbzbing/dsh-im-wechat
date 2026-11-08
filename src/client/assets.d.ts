/**
 * 构建期资源模块声明。
 *
 * `assets/icon.svg` 由 esbuild 的 dataurl loader 以 data URL 内联进 client 产物
 * （见 `scripts/build.mjs`），保证与 package.json 的 icon 同源、运行时零文件依赖。
 * 这里只声明类型；具体装入发生在构建阶段，tsc 不参与。
 */
declare module '*.svg' {
  const url: string;
  export default url;
}