/** Watched repos first, then tags already used on todos. */
export function mergeRepoOptions(
  watched: readonly string[],
  todos: readonly { repo: string | null }[]
): string[] {
  const repos: string[] = []
  const push = (repo: string) => {
    if (!repos.includes(repo)) repos.push(repo)
  }
  for (const repo of watched) push(repo)
  for (const todo of todos) {
    if (todo.repo) push(todo.repo)
  }
  return repos
}
