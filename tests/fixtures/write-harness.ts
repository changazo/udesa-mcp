import { mkdtempSync } from "node:fs";
import type { ChatFileDeps } from "../../src/write/chat-files.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { MemoryMetadataStore } from "../../src/session/metadata.js";
import { MemorySecretStore } from "../../src/session/secret-store.js";
import { MemoryWebSessionSource, revisionOf } from "../../src/web/session.js";
import { WEB_SESSION_OK } from "./fake-web.js";
import { createLogger } from "../../src/util/logger.js";
import { createWriteApp, type WriteApp } from "../../src/write/app.js";
import type { ConfirmationView, Confirmer, Decision } from "../../src/write/confirm.js";
import { parseWriteProfile } from "../../src/write/policy.js";
import { COURSE, FakeMoodle, NOW_UNIX, SITE, syntheticProfile, USER_ID, VALID_TOKEN } from "./fake-moodle.js";
import { SyntheticMarkers } from "./fake-write.js";
import { SyntheticForums } from "./fake-forum.js";
import { SyntheticW2 } from "./fake-w2.js";
import { SyntheticAttendance } from "./fake-attendance.js";

/** Canal fuera de banda de prueba: decide sin intervención y registra lo que «vio» el humano. */
export class FakeConfirmer implements Confirmer {
    readonly channel = "prueba";
    readonly views: ConfirmationView[] = [];
    decisions: Decision[] = [];
    fallback: Decision = "approved";
    /** Se ejecuta mientras el «humano» mira el diálogo (para simular cambios durante la confirmación). */
    during: (() => void) | null = null;
    async confirm(view: ConfirmationView) {
        this.views.push(view);
        this.during?.();
        return { decision: this.decisions.shift() ?? this.fallback };
    }
}

export function writeProfileJson(policy: Record<string, unknown> = {}, top: Record<string, unknown> = {}) {
    return {
        schema_version: "1.0",
        profile_kind: "write",
        profile_id: "sintetico-escritura",
        read_profile: "sintetico",
        read_only: false,
        write_policy: {
            enabled: true,
            sandbox_course_ids: [COURSE],
            courses: { [String(COURSE)]: ["synthetic_test"] },
            limits: { max_items_per_plan: 30, max_messages_per_plan: 1, max_actions_per_day: 200, max_messages_per_day: 20 },
            notify_students_default: false,
            require_out_of_band_from_risk: "R2",
            audit_teacher_text: false,
            confirmation: { dialog: true, dialog_timeout_seconds: 120 },
            ...policy,
        },
        ...top,
    };
}

export interface WriteHarness {
    fake: FakeMoodle;
    markers: SyntheticMarkers;
    forums: SyntheticForums;
    w2: SyntheticW2;
    att: SyntheticAttendance;
    app: WriteApp;
    dir: string;
    clock: { ms: number };
    confirmer: FakeConfirmer;
    secrets: MemorySecretStore;
    logs: string[];
}

/** App de escritura completa contra el Moodle sintético, con estado en un directorio temporal. */
export async function makeWriteHarness(opts: { policy?: Record<string, unknown>; loggedIn?: boolean; dir?: string; remote?: boolean; chatFiles?: ChatFileDeps } = {}): Promise<WriteHarness> {
    const fake = new FakeMoodle();
    const markers = new SyntheticMarkers(fake);
    const forums = new SyntheticForums(fake);
    const w2 = new SyntheticW2(fake);
    const att = new SyntheticAttendance(fake, w2);
    const profile = parseWriteProfile(writeProfileJson(opts.policy), syntheticProfile());
    const secrets = new MemorySecretStore();
    const logs: string[] = [];
    const clock = { ms: NOW_UNIX * 1000 };
    const confirmer = new FakeConfirmer();
    const dir = opts.dir ?? mkdtempSync(join(tmpdir(), "campus-write-"));
    const app = createWriteApp({
        profile,
        secrets,
        metadata: new MemoryMetadataStore(),
        logger: createLogger((l) => logs.push(l), "debug"),
        location: dir,
        fetch: forums.wrapFetch(markers.wrapFetch(fake.fetch)),
        now: () => new Date(clock.ms),
        confirmer,
        webSource: new MemoryWebSessionSource(webSnapshot()),
        webRenewHint: "renovar (test)",
        ...(opts.remote ? { remote: { approvalUrl: (id: string) => `https://remoto.test/aprobar/${id}`, maxRisk: "R3" as const } } : {}),
        ...(opts.chatFiles ? { chatFiles: opts.chatFiles } : {}),
    });
    if (opts.loggedIn ?? true) await app.read.session.adoptCandidate(VALID_TOKEN, "native");
    return { fake, markers, forums, w2, att, app, dir, clock, confirmer, secrets, logs };
}

/** Sesión web sintética válida (cookie de la cuenta docente del Moodle falso). */
export function webSnapshot() {
    const cookies = [{ name: "MoodleSession", value: WEB_SESSION_OK, expires: null }];
    return { v: 1 as const, origin: SITE, path_prefix: "", user_id: USER_ID, cookies, revision: revisionOf(cookies), imported_at: "2026-10-19T00:00:00.000Z" };
}

export async function connectWrite(h: WriteHarness) {
    const server = h.app.server();
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "cliente-prueba", version: "0.0.0" });
    await Promise.all([server.connect(serverT), client.connect(clientT)]);
    return client;
}

export const parseTool = (r: { content: unknown }) => JSON.parse((r.content as { type: string; text: string }[])[0]!.text);
