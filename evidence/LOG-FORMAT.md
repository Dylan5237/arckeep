# 机器日志保存规则

`checks/*.txt` 和 `payload-verification-*/tool-logs/*.txt` 保存工具原始输出。npm、测试运行器和 7-Zip 的输出包含末尾空行及空字段后的空格；这些字节作为原始证据保留。

同目录 `.gitattributes` 对这两类日志设置 `-text -whitespace`，避免 Git 转换换行符，并将工具生成的空白排除在源码格式检查之外。文档和验证脚本仍使用正常的 `git diff --check` 检查。

本次收口只规范化 Markdown 文档末尾空行。原始检查结果、失败尝试、退出码、制品身份及日志内容保持原样。
