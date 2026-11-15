// `@anthropic-ai/bedrock-sdk` is an optionalDependency: reached through
// providers/optional-bedrock.ts at client construction, never as a static
// import. See utils/optional-dependency.ts for the failure a static import of
// an absent optional package produces.
import { loadBedrockLibrary } from './optional-bedrock.js';
import { BEDROCK_DATED_STATIC_MODELS, BEDROCK_DATED_STATIC_MODELS_AS_OF, BedrockFamilyProvider } from './amazon-bedrock.js';

/** Mantle shows the same names as direct Bedrock until its listing is read. */
export const BEDROCK_MANTLE_DATED_STATIC_MODELS: readonly string[] = BEDROCK_DATED_STATIC_MODELS;
export const BEDROCK_MANTLE_DATED_STATIC_MODELS_AS_OF = BEDROCK_DATED_STATIC_MODELS_AS_OF;

/**
 * Bedrock Mantle: the Bedrock family with the Mantle runtime client. Mantle has
 * no listing of its own, so its list is the account's Bedrock catalogue, and
 * each refresh says that the list is not confirmed for the Mantle host.
 */
export class AmazonBedrockMantleProvider extends BedrockFamilyProvider {
  constructor(modelsCachePath?: string, options: { readonly bearerToken?: string | undefined } = {}) {
    super({
      name: 'amazon-bedrock-mantle',
      buildClient: async (credentials) => {
        const { AnthropicBedrockMantle } = await loadBedrockLibrary();
        return new AnthropicBedrockMantle({
          apiKey: credentials.bearerToken,
          awsAccessKey: credentials.accessKey?.id ?? null,
          awsSecretAccessKey: credentials.accessKey?.secret ?? null,
          awsSessionToken: credentials.accessKey?.sessionToken ?? null,
          awsProfile: credentials.profile,
          awsRegion: credentials.region,
        });
      },
      notes: ['Bedrock Mantle uses the Anthropic Bedrock Mantle SDK path.'],
      listingNote: 'listed from the account\'s Bedrock catalogue, not confirmed for the Mantle host',
    }, modelsCachePath, options);
  }
}
