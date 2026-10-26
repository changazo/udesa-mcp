/**
 * Redacción defensiva para logs y mensajes de error. No reemplaza el no-loguear: es la red de
 * seguridad por si algún mensaje de terceros (fetch, Moodle) incluye una URL con credenciales.
 */
const PATTERNS: [RegExp, string][] = [
    // Parámetros de query o form con secretos.
    [/\b(wstoken|token|privatetoken|password|passport|userprivateaccesskey|key|sesskey)=([^&\s"'<>;]+)/gi, "$1=[REDACTED]"],
    // Cookies de sesión web de Moodle (MoodleSession*, MOODLEID*).
    [/\b(MoodleSession\w*|MOODLEID\d*_\w*)=([^;\s"'<>]+)/g, "$1=[REDACTED]"],
    // sesskey en JSON o en M.cfg.
    [/"sesskey"\s*:\s*"[^"]*"/gi, '"sesskey":"[REDACTED]"'],
    // Retorno del lanzamiento móvil: <esquema>://token=<base64>
    [/([a-z][a-z0-9+.-]*):\/\/token=[^\s"'<>]+/gi, "$1://token=[REDACTED]"],
    // JSON con campos sensibles.
    [/"(token|privatetoken|password|userprivateaccesskey|wstoken)"\s*:\s*"[^"]*"/gi, '"$1":"[REDACTED]"'],
    // Tokens de Moodle: 32 hexadecimales.
    [/\b[a-f0-9]{32}\b/gi, "[REDACTED_HEX32]"],
];

export function redact(text: string): string {
    let out = text;
    for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
    return out;
}

/** Quita de una URL los parámetros que pueden dar acceso. Para mostrar enlaces al agente. */
export function stripSecretParams(raw: string): string {
    try {
        const url = new URL(raw);
        for (const name of [...url.searchParams.keys()]) {
            if (/^(wstoken|token|privatetoken|key|sesskey|passport)$/i.test(name)) url.searchParams.delete(name);
        }
        url.username = "";
        url.password = "";
        return url.toString();
    } catch {
        return redact(raw);
    }
}
