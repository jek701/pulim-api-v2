export function retryDelay(attempts: number): number {
  return Math.min(3_600_000, 2_000 * 2 ** Math.max(0, attempts));
}

export function exhaustedAttempts(attempts: number, maximum: number): boolean {
  return attempts >= maximum;
}
