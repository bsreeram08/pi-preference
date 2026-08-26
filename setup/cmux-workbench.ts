import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Compatibility entry retained for existing installer and updater manifests.
 * The main pi-workbench directory extension owns cmux bridge registration.
 */
export default function cmuxWorkbenchCompatibilityExtension(_pi: ExtensionAPI): void {}
