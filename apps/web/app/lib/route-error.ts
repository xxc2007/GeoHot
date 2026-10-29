export function isNetworkRouteError(error: unknown): boolean {
  // Fetch uses TypeError for network failures; ordinary TypeErrors must remain program errors.
  return error instanceof TypeError && /^(?:Failed to fetch|Load failed|NetworkError(?: when attempting to fetch resource\.)?)$/i.test(error.message);
}
