import { SITE } from "./fake-moodle.js";
import { type FakeWeb, WEB_SESSKEY } from "./fake-web.js";

/**
 * Herramientas externas LTI del curso (ADR-117): la tabla de coursetools.php y el formulario de
 * coursetooledit.php (alta y lectura con el ID de cliente). Datos inventados.
 */
export class FakeLtiTools {
    readonly tools: { typeid: number; name: string; clientid: string; fields: Record<string, string> }[] = [{ typeid: 7, name: "Panopto", clientid: "", fields: {} }];
    private seq = 188;

    constructor(web: FakeWeb) {
        web.pages.set("/mod/lti/coursetools.php", () => ({
            body: `<html><body><div role="main"><table><tr><th>Nombre</th></tr>${this.tools.map((t) => `<tr data-id="${t.typeid}"><td><span>${t.name}</span></td><td>desc</td></tr>`).join("")}</table></div></body></html>`,
        }));
        web.pages.set("/mod/lti/coursetooledit.php", (q, req) => {
            if (req.method === "GET") {
                const t = q.typeid ? this.tools.find((x) => x.typeid === Number(q.typeid)) : null;
                return {
                    body: `<html><body><form action="${SITE}/search/index.php"><input name="q"></form><form action="${SITE}/mod/lti/coursetooledit.php" method="post"><input type="hidden" name="sesskey" value="${WEB_SESSKEY}"><input type="hidden" name="_qf__mod_lti_edit_types_form" value="1"><input type="hidden" name="course" value="${q.course}">${t ? `<input name="lti_clientid" type="hidden" value="${t.clientid}"><input type="hidden" name="typeid" value="${t.typeid}">` : ""}<input type="text" name="lti_typename" value=""><textarea name="lti_description"></textarea><input type="text" name="lti_toolurl" value=""><select name="lti_ltiversion"><option value="LTI-1p0" selected>1</option><option value="1.3.0">13</option></select><select name="lti_keytype"><option value="RSA_KEY" selected>r</option><option value="JWK_KEYSET">j</option></select><input type="text" name="lti_publickeyset" value=""><input type="text" name="lti_initiatelogin" value=""><textarea name="lti_redirectionuris"></textarea><textarea name="lti_customparameters"></textarea><select name="lti_launchcontainer"><option value="2" selected>e</option><option value="3">e2</option></select><input type="hidden" name="lti_contentitem" value="0"><select name="ltiservice_gradesynchronization"><option value="0" selected>n</option><option value="1">s</option></select><select name="ltiservice_memberships"><option value="0" selected>n</option></select><select name="ltiservice_toolsettings"><option value="0" selected>n</option></select><select name="lti_sendname"><option value="0">n</option><option value="1" selected>s</option></select><select name="lti_sendemailaddr"><option value="0">n</option><option value="1" selected>s</option></select><select name="lti_acceptgrades"><option value="0">n</option><option value="1" selected>s</option></select><input type="checkbox" name="lti_forcessl" value="1" checked><input type="submit" name="submitbutton" value="Guardar"></form></body></html>`,
                };
            }
            const b = new URLSearchParams(req.body ?? "");
            if (b.get("sesskey") !== WEB_SESSKEY || b.get("_qf__mod_lti_edit_types_form") !== "1") return { body: "<html><body>nope</body></html>" };
            const typeid = this.seq++;
            this.tools.push({ typeid, name: b.get("lti_typename") ?? "", clientid: `cli${typeid}`, fields: Object.fromEntries(b) });
            return { status: 303, body: null, headers: { location: `${SITE}/mod/lti/coursetools.php?id=${b.get("course")}` } };
        });
    }
}
