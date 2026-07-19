/**
 * Default runtime policy shared by composition and workflow authority.
 *
 * This module contains passive configuration data. Runtime mechanisms consume
 * these values but must not redefine them locally, otherwise projected
 * authority can disagree with the child-session coordinator.
 */

/** Maximum number of delegation edges from the root coordinator. */
export const DEFAULT_MAXIMUM_DELEGATION_DEPTH = 3;
