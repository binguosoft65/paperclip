// 提取第一条非空行，用于从多行错误输出中提取有意义的错误信息
export function firstNonEmptyLine(text: string): string {
    return (
        text
            .split(/\r?\n/)
            .map((line) => line.trim())
            .find(Boolean) ?? ""
    );
}
