export function first<T>(arr: T[]): T | undefined {
  return arr.length > 0 ? arr[0] : undefined;
}

export function at<T>(arr: T[], index: number): T | undefined {
  if (index < 0 || index >= arr.length) return undefined;
  return arr[index];
}
