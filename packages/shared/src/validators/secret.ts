import { z } from "zod";
import { SECRET_PROVIDERS } from "../constants.js";

export const envBindingPlainSchema = z.object({
  type: z.literal("plain"),
  value: z.string(),
});

export const envBindingSecretRefSchema = z.object({
  type: z.literal("secret_ref"),
  secretId: z.string().uuid(),
  version: z.union([z.literal("latest"), z.number().int().positive()]).optional(),
});

// Backward-compatible union that accepts legacy inline values.
export const envBindingSchema = z.union([
  z.string(),
  envBindingPlainSchema,
  envBindingSecretRefSchema,
]);

export const envConfigSchema = z.record(envBindingSchema);

export const createSecretSchema = z
  .object({
    name: z.string().min(1),
    provider: z.enum(SECRET_PROVIDERS).optional(),
    managedMode: z.enum(["paperclip_managed", "external_reference"]).optional(),
    value: z.string().min(1).optional(),
    description: z.string().optional().nullable(),
    externalRef: z.string().optional().nullable(),
  })
  .refine(
    (data) => {
      if (data.managedMode !== "paperclip_managed") return true;
      return !data.externalRef;
    },
    { message: "Managed secrets cannot set externalRef", path: ["externalRef"] },
  );

export type CreateSecret = z.infer<typeof createSecretSchema>;

export const rotateSecretSchema = z.object({
  value: z.string().min(1),
  externalRef: z.string().optional().nullable(),
});

export type RotateSecret = z.infer<typeof rotateSecretSchema>;

export const updateSecretSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional().nullable(),
  externalRef: z.string().optional().nullable(),
});

export type UpdateSecret = z.infer<typeof updateSecretSchema>;

const vaultOriginUrl = z
  .string()
  .trim()
  .transform((value) => {
    try {
      const url = new URL(value.trim());
      url.username = "";
      url.password = "";
      url.search = "";
      url.hash = "";
      url.pathname = "";
      return url.origin;
    } catch {
      return value.trim();
    }
  })
  .refine(
    (value) => {
      try {
        const url = new URL(value);
        return (
          (url.protocol === "http:" || url.protocol === "https:") &&
          !url.pathname &&
          !url.search &&
          !url.hash &&
          !url.username &&
          !url.password
        );
      } catch {
        return false;
      }
    },
    { message: "Must be an origin-only HTTP(S) URL with no path, query, hash, or credentials" },
  );

const localProviderConfigSchema = z.object({
  backupReminderAcknowledged: z.boolean().optional(),
});

const awsProviderConfigSchema = z.object({
  region: z.string().min(1),
  namespace: z.string().min(1).optional(),
  secretNamePrefix: z.string().optional(),
});

const vaultProviderConfigSchema = z.object({
  address: vaultOriginUrl,
});

const secretProviderConfigMap = {
  local_encrypted: localProviderConfigSchema,
  aws_secrets_manager: awsProviderConfigSchema,
  vault: vaultProviderConfigSchema,
} as const;

export const secretProviderConfigPayloadSchema = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("local_encrypted"), config: localProviderConfigSchema }),
  z.object({ provider: z.literal("aws_secrets_manager"), config: awsProviderConfigSchema }),
  z.object({ provider: z.literal("vault"), config: vaultProviderConfigSchema }),
]);

export const createSecretProviderConfigSchema = z.intersection(
  secretProviderConfigPayloadSchema,
  z.object({ displayName: z.string().min(1).max(255) }),
);

export const updateSecretProviderConfigSchema = z.union([
  z.object({ config: localProviderConfigSchema }),
  z.object({ config: awsProviderConfigSchema }),
  z.object({ config: vaultProviderConfigSchema }),
]);

export const remoteSecretImportPreviewSchema = z.object({
  providerConfigId: z.string().uuid(),
  query: z.string().optional(),
  pageSize: z.number().int().min(1).max(100).default(50),
});

const remoteImportSecretSchema = z.object({
  externalRef: z.string().min(1),
  name: z.string().min(1).max(255),
  key: z.string().min(1).max(255),
  description: z.string().trim().optional().nullable(),
  providerMetadata: z.record(z.unknown()).optional(),
});

export const remoteSecretImportSchema = z.object({
  providerConfigId: z.string().uuid(),
  secrets: z.array(remoteImportSecretSchema).min(1).max(100),
});

export type CreateSecretProviderConfig = z.infer<typeof createSecretProviderConfigSchema>;
export type RemoteSecretImportPreview = z.infer<typeof remoteSecretImportPreviewSchema>;
export type RemoteSecretImport = z.infer<typeof remoteSecretImportSchema>;
