#!/usr/bin/env node
// Arma un paquete precompilado y multiplataforma (Windows, macOS, Linux) para instalar sin npm.
// Uso: node scripts/empaquetar.mjs [carpeta_de_salida]   (por defecto dist-release/)
//
// Parte del commit actual (git archive HEAD), compila, deja sólo las dependencias de producción y
// agrega los binarios de @napi-rs/keyring de cada plataforma, verificados contra el package-lock.
// @napi-rs/canvas (opcional de pdfjs-dist, ~37 MB por plataforma) se quita: el MCP sólo extrae texto.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")).packages;
const out = resolve(process.argv[2] ?? join(root, "dist-release"));
const name = `udesa-campus-mcp-${pkg.version}`;
const stage = join(out, name);

// Plataformas con Node >= 22 que se distribuyen. FreeBSD, ARM de 32 bits, riscv e ia32 quedan fuera.
const KEYRING_TARGETS = ["win32-x64-msvc", "win32-arm64-msvc", "darwin-x64", "darwin-arm64", "linux-x64-gnu", "linux-arm64-gnu", "linux-x64-musl", "linux-arm64-musl"];
// Lo que no hace falta para usarlo localmente (código fuente, pruebas, remoto en Vercel, laboratorio).
const DROP = ["src", "tests", "api", "lab", "public", "assets", "schemas", "vercel.json", "vitest.config.ts", "tsconfig.json", ".gitignore", ".vercelignore"];

const isWin = process.platform === "win32";
// En Windows, el tar del sistema (bsdtar): el GNU tar de Git Bash toma «C:» como un host remoto y no arma zip.
const TAR = isWin ? join(process.env.SystemRoot ?? "C:/Windows", "System32", "tar.exe") : "tar";
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: ["ignore", "inherit", "inherit"], shell: isWin && cmd === "npm" });

if (execFileSync("git", ["status", "--porcelain", "--", "src", "profiles", "package.json", "package-lock.json", "tsconfig.json"], { cwd: root, encoding: "utf8" }).trim()) {
    console.error("Hay cambios sin commitear en el código: el paquete sale de HEAD y no los incluiría.");
    process.exit(1);
}
rmSync(out, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

console.log(`1/5 Código de ${execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).trim()}`);
const tarFile = join(out, "src.tar");
execFileSync("git", ["archive", "--format=tar", "-o", tarFile, "HEAD"], { cwd: root });
execFileSync(TAR, ["-xf", tarFile, "-C", stage]);
rmSync(tarFile);

console.log("2/5 Compilación");
run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], stage);
run("npm", ["run", "build"], stage);
run("npm", ["prune", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], stage);

console.log("3/5 Binarios del almacén de credenciales");
const napi = join(stage, "node_modules", "@napi-rs");
for (const dir of readdirSync(napi)) if (dir.startsWith("canvas")) rmSync(join(napi, dir), { recursive: true, force: true });
const packs = join(out, "packs");
mkdirSync(packs, { recursive: true });
for (const t of KEYRING_TARGETS) {
    const id = `@napi-rs/keyring-${t}`;
    const entry = lock[`node_modules/${id}`];
    if (!entry?.integrity) throw new Error(`${id} no está en el package-lock`);
    const dest = join(napi, `keyring-${t}`);
    if (existsSync(dest)) continue;
    const file = execFileSync("npm", ["pack", `${id}@${entry.version}`, "--silent", "--pack-destination", packs], { cwd: packs, encoding: "utf8", shell: isWin }).trim().split(/\r?\n/).pop();
    const [algo, expected] = entry.integrity.split("-");
    const got = createHash(algo).update(readFileSync(join(packs, file))).digest("base64");
    if (got !== expected) throw new Error(`${id}: la integridad no coincide con el package-lock`);
    const tmp = join(packs, t);
    mkdirSync(tmp);
    execFileSync(TAR, ["-xzf", join(packs, file), "-C", tmp]);
    renameSync(join(tmp, "package"), dest);
}
rmSync(packs, { recursive: true, force: true });

console.log("4/5 Limpieza e instrucciones");
for (const p of DROP) rmSync(join(stage, p), { recursive: true, force: true });
cpSync(join(root, "docs", "INSTALAR_PAQUETE.md"), join(stage, "INSTALAR.md"));

console.log("5/5 Zip");
const zip = join(out, `${name}.zip`);
// bsdtar (Windows 10+ y macOS) arma zip con -a; en Linux, zip.
if (process.platform === "linux") execFileSync("zip", ["-qr", zip, name], { cwd: out });
else execFileSync(TAR, ["-a", "-cf", zip, name], { cwd: out });
const sha = createHash("sha256").update(readFileSync(zip)).digest("hex");
writeFileSync(`${zip}.sha256`, `${sha}  ${name}.zip\n`);
console.log(`Listo: ${zip}\nsha256 ${sha}`);
