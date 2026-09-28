export const IpcChannel = {
  getState: 'app:get-state',
  setRepos: 'app:set-repos',
  setHotkey: 'app:set-hotkey',
  setPat: 'app:set-pat',
  clearPat: 'app:clear-pat',
  testGithub: 'app:test-github'
} as const
