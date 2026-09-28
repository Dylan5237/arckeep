// 故意制造的 lint 错误，用来验证 CI 会变红。不要合并。
export function lintCanary(): number {
  debugger;
  var unused = 1;
  return 1;
}
