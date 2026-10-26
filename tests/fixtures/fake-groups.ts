/**
 * Grupos sintéticos CON ESTADO (formularios /group/* y inplace_editable core_group/user_groups).
 * Datos inventados. Trampas ([C] §5): user_groups REEMPLAZA el conjunto y no quita las membresías
 * protegidas (de plugins de matriculación); el nombre duplicado vuelve el formulario con error.
 */
import { COURSE, SITE, STUDENT_A, STUDENT_B, USER_ID, type FakeMoodle } from "./fake-moodle.js";
import { WEB_SESSKEY } from "./fake-web.js";

export const G_EXISTING = 4401;
export const G_PROTECTED = 4402;

export class SyntheticGroups {
    readonly groups = [
        { id: G_EXISTING, courseid: COURSE, name: "Comisión 1", idnumber: "", description: "" },
        { id: G_PROTECTED, courseid: COURSE, name: "Cohorte (sincronizada)", idnumber: "coh", description: "" },
    ];
    readonly members = new Map<number, Set<number>>([
        [STUDENT_A, new Set([G_EXISTING])],
        [STUDENT_B, new Set([G_PROTECTED])],
        [USER_ID, new Set()],
    ]);
    /** (usuario, grupo) agregados por un plugin: Moodle no los quita. */
    readonly protectedPairs = new Set([`${STUDENT_B}:${G_PROTECTED}`]);
    readonly posts: Record<string, string>[] = [];
    private seq = 4500;

    constructor(fake: FakeMoodle) {
        fake.overrides.set("core_group_get_course_groups", () => this.groups.map((g) => ({ ...g, descriptionformat: 1 })));
        fake.overrides.set("core_enrol_get_enrolled_users", () =>
            [...this.members.entries()].map(([id, gs]) => ({ id, fullname: `Usuario ${id}`, groups: [...gs].map((g) => ({ id: g, name: this.groups.find((x) => x.id === g)?.name ?? "" })) })),
        );
        const inplace = fake.web.ajax.get("core_update_inplace_editable");
        fake.web.ajax.set("core_update_inplace_editable", (a) => {
            if (a.component !== "core_group") return inplace?.(a);
            const [course, user] = String(a.itemid).split(":").map(Number);
            const set = this.members.get(user!);
            if (course !== COURSE || !set) throw Object.assign(new Error("No matriculado"), { errorcode: "invaliduser" });
            const want = new Set(JSON.parse(String(a.value)) as number[]);
            for (const g of want) if (!this.groups.some((x) => x.id === g)) throw Object.assign(new Error("Grupo ajeno"), { errorcode: "invalidgroupid" });
            for (const g of [...set]) if (!want.has(g) && !this.protectedPairs.has(`${user}:${g}`)) set.delete(g);
            for (const g of want) set.add(g);
            return { displayvalue: "x", value: a.value };
        });
        fake.web.pages.set("/group/group.php", (q, req) => {
            if (req.method === "GET") {
                return {
                    body: `<html><body><form action="${SITE}/group/group.php" method="post"><input type="hidden" name="id" value=""><input type="hidden" name="courseid" value="${q.courseid}"><input type="hidden" name="sesskey" value="${WEB_SESSKEY}"><input type="hidden" name="_qf__group_form" value="1"><input type="text" name="name" value=""><input type="text" name="idnumber" value=""><textarea name="description_editor[text]"></textarea><input type="hidden" name="description_editor[format]" value="1"><input type="text" name="enrolmentkey" value=""><select name="visibility"><option value="0" selected>0</option></select><input type="hidden" name="participation" value="0"><input type="checkbox" name="participation" value="1" checked><input type="hidden" name="enablemessaging" value="0"><input type="checkbox" name="enablemessaging" value="1"><input type="submit" name="submitbutton" value="Guardar"></form></body></html>`,
                };
            }
            const b = new URLSearchParams(req.body ?? "");
            this.posts.push(Object.fromEntries(b));
            const name = b.get("name") ?? "";
            if (this.groups.some((g) => g.name === name)) {
                return { body: `<html><body><form><input type="hidden" name="_qf__group_form" value="1"><span class="error" id="id_error_name">Ya existe un grupo con ese nombre</span></form></body></html>` };
            }
            const id = this.seq++;
            this.groups.push({ id, courseid: Number(b.get("courseid")), name, idnumber: b.get("idnumber") ?? "", description: b.get("description_editor[text]") ?? "" });
            return { status: 303, body: null, headers: { location: `${SITE}/group/index.php?id=${b.get("courseid")}&group=${id}` } };
        });
        fake.web.pages.set("/group/delete.php", (_q, req) => {
            const b = new URLSearchParams(req.body ?? "");
            this.posts.push(Object.fromEntries(b));
            if (b.get("confirm") !== "1" || b.get("sesskey") !== WEB_SESSKEY) return { body: "<html><body>¿Confirmar?</body></html>" };
            const i = this.groups.findIndex((g) => g.id === Number(b.get("groups")));
            if (i >= 0) this.groups.splice(i, 1);
            for (const gs of this.members.values()) gs.delete(Number(b.get("groups")));
            return { status: 303, body: null, headers: { location: `${SITE}/group/index.php?id=${b.get("courseid")}` } };
        });
    }

    groupsOf(userId: number) {
        return [...(this.members.get(userId) ?? [])].sort((a, b) => a - b);
    }
}
