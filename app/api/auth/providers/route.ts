import { buildApiKeyProviderList, buildOAuthProviderList } from "@/lib/provider-listing";
import { collectProviderListingInputs } from "@/lib/provider-listing-runtime";
import { createLiteModelRuntime, createModelRuntimeWithExtensions } from "@/lib/model-runtime";
import { readsUseLiteCatalog } from "@/lib/lite-config-settings";

export const dynamic = "force-dynamic";

// Providers that declare an OAuth login method, including anthropic
// (Claude Pro/Max) — see lib/provider-listing.ts (#309).
export async function GET() {
  // A Lite instance only ever offers built-in and models.json providers,
  // which is everything it can sign in to anyway — and no extension has to
  // load to answer. Normal mode keeps the full runtime.
  const modelRuntime = readsUseLiteCatalog()
    ? await createLiteModelRuntime()
    : await createModelRuntimeWithExtensions();
  const inputs = await collectProviderListingInputs(modelRuntime);
  const oauthProviders = buildOAuthProviderList(inputs);
  const apiKeyProviders = buildApiKeyProviderList(inputs);
  return Response.json({ providers: oauthProviders, oauthProviders, apiKeyProviders });
}
