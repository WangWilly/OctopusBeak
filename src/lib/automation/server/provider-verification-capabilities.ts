import type { HumanAssistanceContract } from "../human-assistance.ts";
import type { CaptchaSourceOwner } from "./captcha-source-freshness.ts";

/** Capabilities whose provider ownership is resolved by the verification host. */
export const PROVIDER_VERIFICATION_CAPABILITIES = ["challenge-image"] as const;
export type ProviderVerificationCapability = typeof PROVIDER_VERIFICATION_CAPABILITIES[number];

export type ProviderVerificationCapabilityOwner = {
  id: string;
  capabilities: readonly ProviderVerificationCapability[];
  owns(contract: HumanAssistanceContract): boolean;
  sourceOwner?: CaptchaSourceOwner;
};

export type ProviderVerificationCapabilityRegistry = {
  /** Resolve only an unambiguous owner for a capability and contract. */
  resolve(
    capability: ProviderVerificationCapability,
    contract: HumanAssistanceContract,
  ): ProviderVerificationCapabilityOwner | null;
  /** Resolve the owner recorded by a capture without re-selecting by order. */
  resolveById(
    capability: ProviderVerificationCapability,
    ownerId: string,
    contract: HumanAssistanceContract,
  ): ProviderVerificationCapabilityOwner | null;
};

function supports(
  owner: ProviderVerificationCapabilityOwner,
  capability: ProviderVerificationCapability,
) {
  return owner.capabilities.includes(capability);
}

/**
 * Keep provider ownership behind one neutral registry. A capability with no
 * owner or more than one matching owner is intentionally unavailable; array
 * order is never used as an implicit policy.
 */
export function createProviderVerificationCapabilityRegistry(
  owners: readonly ProviderVerificationCapabilityOwner[],
): ProviderVerificationCapabilityRegistry {
  const matchingOwners = (
    capability: ProviderVerificationCapability,
    contract: HumanAssistanceContract,
  ) => owners.filter((owner) => supports(owner, capability) && owner.owns(contract));

  return {
    resolve: (capability, contract) => {
      const matches = matchingOwners(capability, contract);
      return matches.length === 1 ? matches[0]! : null;
    },
    resolveById: (capability, ownerId, contract) => {
      const owner = owners.find((candidate) => candidate.id === ownerId);
      if (!owner || !supports(owner, capability) || !owner.owns(contract)) return null;
      const matches = matchingOwners(capability, contract);
      return matches.length === 1 && matches[0]!.id === ownerId ? owner : null;
    },
  };
}
