// ADR-045 / DESIGN-023 — the Authentik + Open WebUI client bundle the role-portal orchestrators run
// against. `@hnet/authentik/write` and `@hnet/openwebui/write` are import-guarded to packages/domain
// (the arr-write-import-guard test, extended for both), exactly like @hnet/plex/write: no other code
// path may create a group or flip a membership. packages/api receives this bundle as an opaque type and
// injects fetch-stubbed clients in tests (mirrors plex-clients.ts).
import { assertAuthentikEnv, AuthentikReadClient, type AuthentikClientOptions } from '@hnet/authentik';
import { AuthentikWriteClient } from '@hnet/authentik/write';
import { assertOwuiEnv, OwuiGroupReadClient, type OwuiClientOptions } from '@hnet/openwebui';
import { OwuiWriteClient } from '@hnet/openwebui/write';

export type { AuthentikClientOptions, OwuiClientOptions };

export interface AuthentikPortalBundle {
  authentik: {
    read: AuthentikReadClient;
    write: AuthentikWriteClient;
  };
  owui: {
    read: OwuiGroupReadClient;
    write: OwuiWriteClient;
  };
}

export interface AuthentikPortalBundleOptions {
  authentik: AuthentikClientOptions;
  owui: OwuiClientOptions;
}

/**
 * Build a portal bundle from explicit client options. Production goes through
 * authentikPortalBundleFromEnv; tests inject `fetchImpl` stubs here so no code outside packages/domain
 * ever imports the write surfaces (the guard).
 */
export function buildAuthentikPortalBundle(options: AuthentikPortalBundleOptions): AuthentikPortalBundle {
  return {
    authentik: {
      read: new AuthentikReadClient(options.authentik),
      write: new AuthentikWriteClient(options.authentik),
    },
    owui: {
      read: new OwuiGroupReadClient(options.owui),
      write: new OwuiWriteClient(options.owui),
    },
  };
}

/**
 * Build the portal bundle from env: `AUTHENTIK_URL` (default = the in-cluster Service DNS) +
 * `AUTHENTIK_API_TOKEN` (required — the hnet-portal service-account token), and `OPENWEBUI_URL`
 * (default = the OWUI Service DNS) + `OPENWEBUI_API_KEY` (required). A missing token throws the
 * respective config error naming only the absent variable (values never echoed).
 */
export function authentikPortalBundleFromEnv(
  env: Record<string, string | undefined> = process.env,
): AuthentikPortalBundle {
  const ak = assertAuthentikEnv(env);
  const owui = assertOwuiEnv(env);
  return buildAuthentikPortalBundle({
    authentik: { baseUrl: ak.baseUrl, token: ak.token },
    owui: { baseUrl: owui.baseUrl, apiKey: owui.apiKey },
  });
}
