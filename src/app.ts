import type { Profile } from "./config/profile.js";
import type { Renderer } from "./documents/render.js";
import type { DownloadLinks } from "./remote/download-links.js";
import { ContextCheckRecorder } from "./capabilities/report.js";
import { CampusService } from "./domain/campus-service.js";
import { createServer, type ServerDeps } from "./mcp/server.js";
import type { FetchLike } from "./moodle/transport.js";
import { CourseScope } from "./policy/course-scope.js";
import { ResourceRegistry } from "./policy/registry.js";
import type { MetadataStore } from "./session/metadata.js";
import type { SecretStore } from "./session/secret-store.js";
import { SessionManager } from "./session/session-manager.js";
import type { Logger } from "./util/logger.js";
import type { WebSessionSource } from "./web/session.js";
import { WebTransport } from "./web/transport.js";

/** Raíz de composición: una sola implementación de dominio para cualquier método de login. */
export interface AppDeps {
    profile: Profile;
    secrets: SecretStore;
    metadata: MetadataStore;
    logger: Logger;
    fetch?: FetchLike;
    now?: () => Date;
    loginHint?: string;
    /** Sesión web (cookies) independiente del token móvil; sin ella sólo funcionan las lecturas REST. */
    webSource?: WebSessionSource;
    /** Cómo renovar la sesión web en este modo (local: CLI; remoto: configuración). */
    webRenewHint?: string;
    /** Carpeta de descargas de campus_get_original_file (sólo servidores locales; ADR-112). */
    downloadDir?: string | null;
    /** Conversores locales para render de páginas (ADR-112). */
    renderer?: Renderer | null;
    /** Enlaces temporales de descarga (sólo remoto; ADR-113). */
    downloadLinks?: DownloadLinks | null;
    /** User-Agent de las peticiones web (ADR-121); por defecto el del servidor local. */
    webUserAgent?: string;
}

export function createApp(deps: AppDeps) {
    const session = new SessionManager(deps);
    const registry = new ResourceRegistry(deps.profile.allowed_course_ids, undefined, deps.now ? () => deps.now!().getTime() : Date.now);
    const recorder = new ContextCheckRecorder();
    const scope = new CourseScope(deps.profile, session, deps.logger, deps.now ? () => deps.now!().getTime() : Date.now);
    const web = deps.webSource
        ? new WebTransport({
              siteUrl: deps.profile.site_url,
              source: deps.webSource,
              expectedUserId: async () => (await session.verified()).info.userid,
              logger: deps.logger,
              timeoutMs: deps.profile.limits.http_timeout_seconds * 1000,
              fetch: deps.fetch,
              renewHint: deps.webRenewHint ?? "Importá la sesión web del Campus con la CLI.",
              userAgent: deps.webUserAgent,
          })
        : null;
    const service = new CampusService({ profile: deps.profile, session, registry, scope, recorder, logger: deps.logger, now: deps.now, web });
    const serverDeps: ServerDeps = { profile: deps.profile, session, service, scope, recorder, metadata: deps.metadata, logger: deps.logger, downloadDir: deps.downloadDir ?? null, renderer: deps.renderer ?? null, downloadLinks: deps.downloadLinks ?? null };
    const server = () => createServer(serverDeps);
    return { session, registry, scope, recorder, service, server, serverDeps, web };
}

export type App = ReturnType<typeof createApp>;
