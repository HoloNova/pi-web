import { buildApiKeyProviderList, buildOAuthProviderList } from "@/lib/provider-listing";
import { collectProviderListingInputs } from "@/lib/provider-listing-runtime";
import { createLiteModelRuntime, createModelRuntimeWithExtensions } from "@/lib/model-runtime";
import { isLiteRequest } from "@/lib/lite-request";

export const dynamic = "force-dynamic";

// Providers that declare an OAuth login method, including anthropic
// (Claude Pro/Max) — see lib/provider-listing.ts (#309).
export async function GET(req: Request) {
  // A Lite tab gets the built-in and models.json providers only, which is
  // everything it can sign in to anyway — and no extension has to load to
  // answer. Normal mode keeps the full runtime.
  const modelRuntime = isLiteRequest(req)
    ? await createLiteModelRuntime()
    : await createModelRuntimeWithExtensions();
  const inputs = await collectProviderListingInputs(modelRuntime);
  const oauthProviders = buildOAuthProviderList(inputs);
  const apiKeyProviders = buildApiKeyProviderList(inputs);
  return Response.json({ providers: oauthProviders, oauthProviders, apiKeyProviders });
}
