/** 单个源文件（`src/` 与 `test/` 下的 .ts）的行数上限（AGENTS.md「文件不超过约 500 行」；测试与规则共用这一个常量）。 */
export const MAX_SOURCE_LINES = 500;

/** 会话标题的展示/落盘上限：状态文件与命令快照共用，超长只做截断。 */
export const MAX_TITLE_LENGTH = 200;
