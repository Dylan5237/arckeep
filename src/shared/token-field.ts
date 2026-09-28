/** Keep whatever the user pasted when the attempt failed. */
export function pastedTokenAfterAttempt(pasted: string, succeeded: boolean): string {
  if (succeeded) return ''
  return pasted
}
