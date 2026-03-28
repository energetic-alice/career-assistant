/**
 * Shared Google Auth helper.
 * Supports both file-based credentials (local dev) and env var JSON (production).
 */
export async function getGoogleAuth(scopes: string[]) {
  const { google } = await import("googleapis");

  const jsonEnv = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (jsonEnv) {
    const credentials = JSON.parse(jsonEnv);
    return new google.auth.GoogleAuth({ credentials, scopes });
  }

  const keyFile = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (keyFile) {
    return new google.auth.GoogleAuth({ keyFile, scopes });
  }

  throw new Error(
    "Google credentials not configured. Set GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_SERVICE_ACCOUNT_KEY.",
  );
}
