import { CampusError } from "../errors.js";
import { AssignUserFlagsSchema, type AssignParticipant } from "../moodle/schemas.js";
import type { MoodleTransport } from "../moodle/transport.js";

/**
 * Guarda de `mod_assign_get_submission_status` (ADR-051).
 *
 * En Moodle 5.1 esa lectura CREA un registro de entrega vacío (estado `new`) cuando el participante
 * no tiene ninguno: `get_assign_feedback_status_renderable`, `is_graded` y `get_grading_status`
 * llaman a `assign::get_user_grade($userid, false)`, que con `attemptnumber = -1` invoca igual
 * `get_user_submission($userid, true)` (o `get_group_submission(..., true)` en entregas grupales).
 * Como el renderable de la entrega se arma antes, la primera respuesta trae `submission = null` y el
 * registro aparece recién en la segunda.
 *
 * `mod_assign_list_participants` (SQL con LEFT JOIN a assign_submission, latest = 1) devuelve
 * `submissionstatus = ''` cuando no hay registro: es la consulta previa, sin efectos.
 */
export function hasSubmissionRecord(participants: readonly AssignParticipant[], userId: number, teamSubmission: boolean): boolean {
    const has = (p: AssignParticipant) => !!p.submissionstatus;
    const me = participants.find((p) => p.id === userId);
    if (!me) return false;
    if (has(me)) return true;
    if (!teamSubmission) return false;
    // Entrega grupal: la entrega es del grupo (userid = 0) y sólo quien la edita recibe un registro
    // propio. Si algún compañero de grupo tiene registro, el del grupo ya existe y la lectura no crea
    // nada; sin grupo, Moodle usa el grupo por defecto (los participantes sin grupo).
    const mine = new Set((me.groups ?? []).map((g) => g.id));
    return participants.some(
        (p) => p.id !== userId && has(p) && (mine.size ? (p.groups ?? []).some((g) => mine.has(g.id)) : !(p.groups ?? []).length),
    );
}

/** Prórroga y bloqueo de un participante sin pasar por get_submission_status (mod_assign_get_user_flags, sólo SELECT). */
export async function readUserFlags(t: Pick<MoodleTransport, "call">, assignmentId: number, userId: number): Promise<{ extension: number; locked: boolean }> {
    const res = await t.call("mod_assign_get_user_flags", { assignmentids: [assignmentId] }, AssignUserFlagsSchema);
    // Sin permiso Moodle no lanza excepción: devuelve el aviso 1 y ninguna bandera. No es «sin prórroga».
    if (res.warnings?.some((w) => w.warningcode === "1")) {
        throw new CampusError("MOODLE_PERMISSION_DENIED", `Moodle no permite leer las banderas de la tarea ${assignmentId} (mod/assign:grade).`);
    }
    const f = res.assignments.find((a) => a.assignmentid === assignmentId)?.userflags.find((x) => x.userid === userId);
    return { extension: f?.extensionduedate || 0, locked: f?.locked === 1 };
}

export const NO_SUBMISSION_WARNING =
    "Sin entrega: el participante no tiene registro de entrega en Moodle (mod_assign_list_participants). No se consultó mod_assign_get_submission_status porque esa lectura crea un registro vacío (ADR-051).";
