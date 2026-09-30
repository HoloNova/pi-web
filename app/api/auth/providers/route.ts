import { buildApiKeyProviderList, buildOAuthProviderList } from "@/lib/provider-listing";
import { collectProviderListingInputs } from "@/lib/provider-listing-runtime";
import { withExtensionRuntime } from "@/lib/model-runtime";

export const dynamic = "force-dynamic";

// Providers that declare an OAuth login method, including anthropic
// (Claude Pro/Max) — see lib/provider-listing.ts (#309).
//
// Reading the list loads every configured extension (they register providers),
// so the runtime comes from the wrapper that releases them again.
export async function GET() {
  return withExtensionRuntime(async (modelRuntime) => {
    const inputs = await collectProviderListingInputs(modelRuntime);
    const oauthProviders = buildOAuthProviderList(inputs);
    const apiKeyProviders = buildApiKeyProviderList(inputs);
    return Response.json({ providers: oauthProviders, oauthProviders, apiKeyProviders });
  });
}
