import { z } from "zod";
import { CampusError } from "../../errors.js";
import type { IntentContext } from "../intent.js";

/**
 * Paquete de una actividad H5P según `mod_h5pactivity_get_h5pactivities_by_courses` (ADR-104): la
 * estructura del curso no lo trae. Lo usan el reemplazo de archivos y la verificación de altas.
 */

const H5PSchema = z.object({
    h5pactivities: z
        .array(
            z.object({
                coursemodule: z.number().int(),
                package: z.array(z.object({ filename: z.string().nullable().optional(), filepath: z.string().nullable().optional(), filesize: z.number().nullable().optional() })).nullable().optional(),
            }),
        )
        .default([]),
});

/** `nombre:bytes` de los archivos del paquete, o null si el Campus no informa la actividad. */
export async function h5pPackageOf(ctx: IntentContext, courseId: number, cmid: number): Promise<string[] | null> {
    const h = (await ctx.read.session.transport.call("mod_h5pactivity_get_h5pactivities_by_courses", { courseids: [courseId] }, H5PSchema)).h5pactivities.find((x) => x.coursemodule === cmid);
    if (!h) return null;
    return (h.package ?? []).map((f) => `${f.filepath && f.filepath !== "/" ? f.filepath : ""}${f.filename ?? "?"}:${f.filesize ?? "?"}`).sort();
}

export async function requireH5pPackage(ctx: IntentContext, courseId: number, cmid: number): Promise<string[]> {
    const p = await h5pPackageOf(ctx, courseId, cmid);
    if (!p) throw new CampusError("UNEXPECTED_RESPONSE", `El Campus no informa la actividad H5P ${cmid}.`);
    return p;
}
