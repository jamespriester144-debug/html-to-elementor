export function getRequiredEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

export function getSiteUrl(): string {
  return process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
}

export function getBooleanEnv(name: string, defaultValue = false): boolean {
  const value = process.env[name];

  if (!value) {
    return defaultValue;
  }

  const normalized = value.trim().toLowerCase();

  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return defaultValue;
}

export function isForceVisualSnapshotEnabled(): boolean {
  return getBooleanEnv("FORCE_VISUAL_SNAPSHOT", true);
}

export function isUniversalInputAnalysisEnabled(): boolean {
  return getBooleanEnv("UNIVERSAL_INPUT_ANALYSIS", false);
}

export function isSafeFullPageFallbackEnabled(): boolean {
  return getBooleanEnv("SAFE_FULL_PAGE_FALLBACK", false);
}

export function isVisualDebugEnabled(): boolean {
  return getBooleanEnv("VISUAL_DEBUG", false);
}

export function isDebugConversionEnabled(): boolean {
  return getBooleanEnv("DEBUG_CONVERSION", false);
}
