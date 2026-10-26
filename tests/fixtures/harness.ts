import { createApp } from "../../src/app.js";
import type { DownloadLinks } from "../../src/remote/download-links.js";
import type { Profile } from "../../src/config/profile.js";
import { MemoryMetadataStore } from "../../src/session/metadata.js";
import { MemorySecretStore, secretAccount } from "../../src/session/secret-store.js";
import { createLogger } from "../../src/util/logger.js";
import type { WebSessionSource } from "../../src/web/session.js";
import { FakeMoodle, NOW_UNIX, syntheticProfile, VALID_TOKEN } from "./fake-moodle.js";

export interface Harness {
    fake: FakeMoodle;
    profile: Profile;
    secrets: MemorySecretStore;
    metadata: MemoryMetadataStore;
    logs: string[];
    app: ReturnType<typeof createApp>;
}

/** App completa contra el Moodle falso. `loggedIn` adopta un token válido como lo haría la CLI. */
export async function makeHarness(opts: { loggedIn?: boolean; profile?: Record<string, unknown>; webSource?: WebSessionSource; downloadDir?: string; downloadLinks?: DownloadLinks } = {}): Promise<Harness> {
    const fake = new FakeMoodle();
    const profile = syntheticProfile(opts.profile);
    const secrets = new MemorySecretStore();
    const metadata = new MemoryMetadataStore();
    const logs: string[] = [];
    const logger = createLogger((l) => logs.push(l), "debug");
    const app = createApp({ profile, secrets, metadata, logger, fetch: fake.fetch, now: () => new Date(NOW_UNIX * 1000), webSource: opts.webSource, webRenewHint: "renovar (test)", downloadDir: opts.downloadDir ?? null, downloadLinks: opts.downloadLinks ?? null });
    if (opts.loggedIn ?? true) await app.session.adoptCandidate(VALID_TOKEN, "native");
    return { fake, profile, secrets, metadata, logs, app };
}

export const accountFor = (p: Profile) => secretAccount(p.profile_id, p.site_url, p.service);
