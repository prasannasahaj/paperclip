import { describe, expect, it, vi } from "vitest";
import { createOAuthClientProtocol } from "../services/tool-access/oauth/client.js";

function protocolReturning(body: unknown) {
  const fetchRemoteHttpUrl = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
  const { exchangeOAuthToken } = createOAuthClientProtocol({
    fetchRemoteHttpUrl,
    assertOAuthEndpointUrl: (_kind: string, url: string) => url,
  } as never);
  return (
    () => exchangeOAuthToken({
      tokenUrl: "https://slack.com/api/oauth.v2.access",
      clientId: "client",
      clientSecret: "secret",
      redirectUri: "https://paperclip.example/api/tools/oauth/callback",
      code: "code",
      codeVerifier: "verifier",
    })
  );
}

describe("oauth token exchange with a Slack user-token response", () => {
  it("uses the authed_user token when no top-level token is returned", async () => {
    const exchange = protocolReturning({
      ok: true,
      authed_user: {
        id: "U1",
        scope: "search:read.public,users:read",
        access_token: "xoxp-user",
        refresh_token: "xoxe-refresh",
        expires_in: 43200,
        token_type: "user",
      },
    });

    await expect(exchange()).resolves.toMatchObject({
      accessToken: "xoxp-user",
      refreshToken: "xoxe-refresh",
      expiresIn: 43200,
      scope: "search:read.public users:read",
      tokenType: "user",
    });
  });

  it("keeps the top-level token when the provider returns one", async () => {
    const exchange = protocolReturning({ access_token: "top", scope: "a b", token_type: "Bearer" });

    await expect(exchange()).resolves.toMatchObject({ accessToken: "top", scope: "a b", tokenType: "Bearer" });
  });
});
