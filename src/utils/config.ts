/**
 * Configuration loader for the Cloudflare Workers MCP Server
 */

export interface Config {
  apiToken: string;
  accountId: string;
}

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

/**
 * Load configuration from environment variables
 */
export function loadConfig(): Config {
  // Trim surrounding whitespace/newlines that commonly sneak in from copy-paste
  // or shell heredocs and would otherwise corrupt the Authorization header.
  const apiToken = process.env.CLOUDFLARE_API_TOKEN?.trim();
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();

  if (!apiToken) {
    throw new ConfigurationError(
      "CLOUDFLARE_API_TOKEN environment variable is required.\n\n" +
        "To create an API token:\n" +
        "1. Go to https://dash.cloudflare.com/profile/api-tokens\n" +
        "2. Click 'Create Token'\n" +
        "3. Use the 'Edit Cloudflare Workers' template, or create a custom token with:\n" +
        "   - Workers Scripts: Edit (or Read for read-only operations)\n" +
        "4. Set the token as CLOUDFLARE_API_TOKEN environment variable"
    );
  }

  if (!accountId) {
    throw new ConfigurationError(
      "CLOUDFLARE_ACCOUNT_ID environment variable is required.\n\n" +
        "To find your account ID:\n" +
        "1. Go to https://dash.cloudflare.com\n" +
        "2. Select your account\n" +
        "3. The account ID is in the URL: dash.cloudflare.com/<account_id>/...\n" +
        "   Or find it in the sidebar under 'Account ID'\n" +
        "4. Set it as CLOUDFLARE_ACCOUNT_ID environment variable"
    );
  }

  return { apiToken, accountId };
}
