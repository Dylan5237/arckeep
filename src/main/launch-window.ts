/** Whether ready-to-show should reveal the main window. Screenshot capture keeps its own rule. */
export function shouldShowMainWindowOnReady(input: {
  screenshot: boolean
  screenshotShowsMainWindow: boolean
  hideMainWindowOnLaunch: boolean
}): boolean {
  if (input.screenshot) return input.screenshotShowsMainWindow
  return input.hideMainWindowOnLaunch !== true
}
