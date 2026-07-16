/**
 * Current and only supported Phenix-owned runtime API version.
 * Persisted records with any other value are rejected; no migrations are retained.
 */
export const PHENIX_API_VERSION = 1 as const;

export type PhenixApiVersion = typeof PHENIX_API_VERSION;
