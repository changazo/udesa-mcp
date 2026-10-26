import { describe, expect, it } from "vitest";
import { mayNotify, type WritePolicy } from "../../src/write/policy.js";

/** ADR-115: notificar sólo a las cuentas de prueba del sandbox (o con el permiso general). */
const base = { allow_participant_notifications: false, sandbox_course_ids: [12345], notifiable_user_ids: [90001, 90002] } as unknown as WritePolicy;

describe("mayNotify (ADR-115)", () => {
    it("cuentas de prueba en el sandbox sí; otras personas o cursos reales no", () => {
        expect(mayNotify(base, 12345, [90002])).toBe(true);
        expect(mayNotify(base, 12345, [90001, 90002])).toBe(true);
        expect(mayNotify(base, 12345, [90002, 1338])).toBe(false);
        expect(mayNotify(base, 67890, [90002])).toBe(false);
        expect(mayNotify(base, 12345, [])).toBe(false);
        expect(mayNotify({ ...base, allow_participant_notifications: true } as WritePolicy, 67890, [1])).toBe(true);
    });
});
