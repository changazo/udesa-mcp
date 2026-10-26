import { cliCommand } from "./util/cli-command.js";
import { redact } from "./util/redact.js";

/**
 * Códigos estables para el cliente MCP y la CLI. Los diez primeros vienen del contrato de la
 * especificación inicial del proyecto; el resto son extensiones documentadas en docs/DECISIONES.md.
 */
export type CampusErrorCode =
    | "AUTH_REQUIRED"
    | "AUTH_REJECTED"
    | "SERVICE_UNAVAILABLE"
    | "FUNCTION_NOT_AVAILABLE"
    | "POLICY_DENIED"
    | "RESOURCE_OUT_OF_SCOPE"
    | "MOODLE_PERMISSION_DENIED"
    | "NETWORK_ERROR"
    | "UNSUPPORTED_CONTENT"
    | "INCOMPLETE_RESULT"
    | "CONFIG_INVALID"
    | "SECRET_STORE_UNAVAILABLE"
    | "IDENTITY_MISMATCH"
    | "UNEXPECTED_RESPONSE"
    | "AMBIGUOUS_RESOURCE"
    | "BROWSER_CALLBACK_REJECTED"
    | "MOODLE_ERROR"
    // Escrituras (directiva de escrituras §6.4, ADR-044). Sólo los emite el servidor de escritura.
    | "WRITE_DISABLED"
    | "WRITE_NOT_ALLOWED"
    | "PLAN_EXPIRED"
    | "PLAN_STALE"
    | "PLAN_ALREADY_EXECUTED"
    | "CONFIRMATION_REQUIRED"
    | "MOODLE_REJECTED"
    | "VERIFICATION_FAILED"
    | "PARTIAL_APPLIED"
    | "LIMIT_EXCEEDED";

export interface CampusErrorOptions {
    /** Próximo paso para el humano (nunca "pasame tu contraseña"). */
    humanAction?: string;
    /** errorcode original de Moodle, si lo hubo. Es evidencia, no un secreto. */
    moodleErrorcode?: string;
    /** Datos adicionales seguros (p. ej. candidatos de foro). */
    details?: Record<string, unknown>;
}

export class CampusError extends Error {
    readonly code: CampusErrorCode;
    readonly humanAction: string | undefined;
    readonly moodleErrorcode: string | undefined;
    readonly details: Record<string, unknown> | undefined;

    constructor(code: CampusErrorCode, message: string, options: CampusErrorOptions = {}) {
        super(redact(message));
        this.name = "CampusError";
        this.code = code;
        this.humanAction = options.humanAction;
        this.moodleErrorcode = options.moodleErrorcode;
        this.details = options.details;
    }
}

export interface PublicError {
    code: CampusErrorCode;
    message: string;
    human_action: string | null;
    moodle_errorcode: string | null;
    details?: Record<string, unknown>;
}

/** Proyección saneada de cualquier error: sin stacks, sin URLs con token. */
export function toPublicError(e: unknown): PublicError {
    if (e instanceof CampusError) {
        return {
            code: e.code,
            message: e.message,
            human_action: e.humanAction ?? null,
            moodle_errorcode: e.moodleErrorcode ?? null,
            ...(e.details ? { details: e.details } : {}),
        };
    }
    const message = e instanceof Error ? e.message : String(e);
    return {
        code: "MOODLE_ERROR",
        message: `Error interno no clasificado: ${redact(message).slice(0, 300)}`,
        human_action: null,
        moodle_errorcode: null,
    };
}

export const LOGIN_HINT = (profileId: string) =>
    `Iniciá sesión desde tu propia terminal: ${cliCommand()} auth login --profile ${profileId} --method native`;
