// 独立验收用的假 apo 命令（不是被测产品代码）。
// 目的：windows-latest 跑手上大概率没有真的 apo 工具，如果预演阶段命令找不到，
// 应用会把「预演失败」，确认按钮直接隐藏，没法用真实界面点通「预览→确认」这条链路。
// 这个 stub 让 --dry-run 和真实执行都稳定成功：
//   --dry-run：只打印两行 "creating: xxx"（能被产品的文件列表解析器认出来），不落盘；
//   否则：真的在当前目录写两个文件，打印 real-init-done。
// P2 要核对的「确认后真的执行的命令有没有 --dry-run」完全通过操作系统层面
// （解码 PowerShell -EncodedCommand 后的真实脚本文本）独立核实，不依赖这个 stub 的行为。
const args = process.argv.slice(2)
const isDryRun = args.includes('--dry-run')
const nameIndex = args.indexOf('--name')
const name = nameIndex >= 0 && args[nameIndex + 1] ? args[nameIndex + 1] : 'project'

if (isDryRun) {
  console.log(`creating: ${name}.json`)
  console.log(`creating: ${name}.config`)
  process.exit(0)
} else {
  const fs = await import('node:fs')
  fs.writeFileSync(`${name}.json`, '{}\n')
  fs.writeFileSync(`${name}.config`, 'real-init\n')
  console.log('real-init-done')
  process.exit(0)
}
