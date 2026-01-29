export function isGmailThreadId(id: string): boolean {
  // Gmail thread IDs are hex strings, variable length (often ~16 chars)
  return /^[0-9a-fA-F]{16,}$/.test(id) && !id.includes("@");
}

export function isEmail(id: string): boolean {
  // Simple email validation
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(id);
}

export function normalizeGmailTarget(raw: string): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;

  if (isEmail(trimmed)) {
    return trimmed.toLowerCase();
  }

  if (isGmailThreadId(trimmed)) {
    return trimmed.toLowerCase();
  }

  return null;
}

export function isAllowed(senderId: string, allowList: string[]): boolean {
  if (allowList.length === 0) return false;
  if (allowList.includes("*")) return true;

  const normalizedSender = senderId.toLowerCase();
  return allowList.some((entry) => {
    const normalized = entry.toLowerCase().trim();
    if (!normalized) return false;
    // Exact match
    if (normalizedSender === normalized) return true;
    // Domain wildcard match (e.g., "@gmail.com")
    if (normalized.startsWith("@") && normalizedSender.endsWith(normalized)) {
      return true;
    }
    return false;
  });
}
