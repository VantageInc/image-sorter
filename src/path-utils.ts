const WINDOWS_DRIVE_PATH = /^[a-z]:[\\/]/i;
const WINDOWS_UNC_PATH = /^[\\/]{2}[^\\/]/;

function usesCaseInsensitivePathSemantics(value: string): boolean {
  return WINDOWS_DRIVE_PATH.test(value) || WINDOWS_UNC_PATH.test(value);
}

export function normalizePathForComparison(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '');
  return usesCaseInsensitivePathSemantics(value)
    ? normalized.toLowerCase()
    : normalized;
}
