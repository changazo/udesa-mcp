# Estrategia `browser` (Google institucional)

Login con el botón de Google institucional del Campus, por el lanzamiento de la app móvil de Moodle (`launch.php`). En UdeSA funciona con el **pegado manual** del retorno: da la misma cuenta de Moodle (el mismo userid) que el login nativo y, como Moodle reutiliza el token vigente, el mismo token. El **retorno automático** para Windows está implementado pero en pausa: funciona en un Chrome limpio y no en algunos perfiles de Chrome con extensiones o políticas (causa sin identificar).

> Guía práctica para usarlo (pasos, qué copiar, problemas frecuentes): [LOGIN_GOOGLE.md](LOGIN_GOOGLE.md). Este documento es el diseño técnico.

## Uso

En tu terminal (no por chat), en la carpeta del proyecto:

```bash
node build/cli.js auth login --profile udesa-docente --method browser
```

1. Se abre tu navegador en `launch.php?…&oauthsso=4&confirmed=1` (o abrí el «Enlace de inicio» que imprime la CLI con `--no-open`).
2. Completás el login con Google como siempre (MFA incluido). El MCP no ve nada de Google. **No uses F5 ni vuelvas atrás.**
3. Al final, el Campus muestra una página «Registro confirmado» con el enlace azul «Haga clic aquí si la aplicación no se abre automáticamente». Clic derecho → «Copiar dirección del enlace»: empieza con `udesacampusmcp://token=…` (o `moodlemobile://token=…` si el sitio fuerza el esquema de la app oficial). Si Windows ofrece abrir la app de Moodle, cancelá.
4. Pegalo en la terminal (entrada oculta). **Contiene un token:** no lo pegues en chats, issues ni capturas.

**Por qué `confirmed=1`:** sin ese parámetro, `launch.php` redirige directamente al esquema. Si ningún programa lo maneja, Chrome cancela esa navegación y deja visible la página anterior (Google, con la barra de carga): parece «congelado» aunque el token ya se emitió. Un F5 ahí repite el login con un código ya usado y Moodle termina en `login/index.php` con «necesita salir antes de volver a entrar». Con `confirmed=1`, Moodle 5.1 muestra una página con el enlace visible (código de `admin/tool/mobile/launch.php`); no tiene otros efectos.

La CLI valida la transacción (hash `md5(wwwroot+passport)`, vencimiento de 10 min, un solo uso, esquema), después el token contra Moodle (sitio + userid) y la identidad contra la registrada en el perfil: si Google lleva a otra cuenta de Moodle, se rechaza sin reemplazar la sesión. Al final informa si el sitio respetó el esquema propio o forzó el oficial.

Opciones: `--idp <id>` (otro proveedor), `--scheme <esquema>` (por defecto `udesacampusmcp`), `--no-open` (no abre el navegador; sólo imprime el enlace de inicio).

## Comportamiento en UdeSA (Moodle 5.1)

- **Configuración pública de login móvil:** `typeoflogin = 1` («dentro de la app»), `launchurl = …/admin/tool/mobile/launch.php` y un proveedor, «Continuar con cuenta institucional UdeSA» (`auth/oauth2/login.php?id=4`).
- **Tipo de login:** con `oauthsso`, `launch.php` manda al login OAuth2 y, al volver, emite el token sin exigir `typeoflogin` de navegador, porque OAuth2 está habilitado.
- **Esquema:** la configuración autenticada no informa `forcedurlscheme` y el Campus respeta el esquema propio `udesacampusmcp`, así que no hace falta tocar `moodlemobile`.
- **Retorno en Windows:** implementado como decisión de diseño (ADR-025), con el esquema en `HKCU` y un named pipe. Está en pausa porque en algunos perfiles de Chrome el diálogo no aparece. Alternativa sin explorar: retorno por portapapeles.
- **Importador manual oculto:** es el método vigente.
- **WSL/Linux:** sin soporte declarado ni probado.

## Contrato

```text
CLI (humano) ──► createLaunch(profile, urlscheme, oauthsso)  transacción: id, passport aleatorio (24 bytes), expira en 10 min
              ──► abre launch_url en el navegador NORMAL  https://<campus>/admin/tool/mobile/launch.php?service=…&passport=…&urlscheme=…&oauthsso=<id>
humano        ──► login Moodle o botón Google existente (MFA incluido), sin intervención del MCP
navegador     ──► <urlscheme>://token=<base64(md5(wwwroot+passport):::token[:::privatetoken])>
Windows       ──► manejador `auth callback` → named pipe del usuario → login que espera   (respaldo: el humano pega el enlace)
CLI           ──► TransactionStore.consume(retorno)     un solo uso; hash, perfil, sitio, esquema y expiración
              ──► SessionManager.adoptCandidate(token, "browser")   misma validación que native: sitio + userid
```

Todo lo posterior a `adoptCandidate` es idéntico al método nativo. Las tools no saben qué método se usó.

**Manejador de Windows:** `auth handler install` registra `udesacampusmcp` en `HKCU`. Al abrirse el esquema, el manejador entrega el enlace por un named pipe del usuario al login que espera: protocolo de una línea, 4 KB como máximo, una sola entrega. El pegado manual queda como respaldo. Windows agrega una barra final al enlace; `parseCallback` prueba sin UNA barra final si no decodifica tal cual.

Garantías implementadas y testeadas del retorno: correlación por `md5(wwwroot + passport)` comparada en tiempo constante; un retorno de otro sitio no quema la transacción legítima; un retorno que coincide pero es de otro perfil, otro esquema o está vencido se rechaza **y** quema la transacción; repetición rechazada; payload inválido, demasiado largo o con campos de más se rechaza sin incluir el payload en el error; `privatetoken` se descarta. El esquema `moodlemobile` de la app oficial nunca se pide ni se registra; sólo se acepta un retorno con ese esquema en el importador manual, cuando el sitio lo fuerza, y se informa.

## Lo que esta estrategia nunca hace

No lee ni intercepta contraseñas, cookies o tokens de Google; no usa Gmail API ni registra clientes OAuth de Google; no usa navegadores embebidos o headless para el login real; no evade CAPTCHA/MFA; no asume que `launch.php` acepte `redirect_uri=http://127.0.0.1:…`.
