import { buildApiKeyProviderList, buildOAuthProviderList } from "@/lib/provider-listing";
import { collectProviderListingInputs } from "@/lib/provider-listing-runtime";
import { withCatalogRuntime } from "@/lib/model-runtime";

export const dynamic = "force-dynamic";

// Providers that declare an OAuth login method, including anthropic
// (Claude Pro/Max) — see lib/provider-listing.ts (#309).
//
// The runtime comes from `withCatalogRuntime()`: a Lite instance answers from
// the built-in catalogue it can actually sign in to (no extension loads), and
// anything else loads them and releases them again.
export async function GET() {
  return withCatalogRuntime(async (modelRuntime) => {
    const inputs = await collectProviderListingInputs(modelRuntime);
    const oauthProviders = buildOAuthProviderList(inputs);
    const apiKeyProviders = buildApiKeyProviderList(inputs);
    return Response.json({ providers: oauthProviders, oauthProviders, apiKeyProviders });
  });
}
