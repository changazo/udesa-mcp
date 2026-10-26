import { createRemoteHandler } from "./handler.js";

/**
 * Adaptador para Vercel. `vercel.json` reescribe todas las rutas a /api con `__route=<ruta>`;
 * según cómo llegue la URL (original o reescrita), se reconstruye la ruta pública.
 */
export function withRouteParam(handler: (req: Request) => Promise<Response>) {
    return async (request: Request): Promise<Response> => {
        const url = new URL(request.url);
        const route = url.searchParams.get("__route");
        if (route !== null) {
            url.searchParams.delete("__route");
            url.pathname = route.startsWith("/") ? route : `/${route}`;
            request = new Request(url, request);
        }
        return handler(request);
    };
}

let cached: ((req: Request) => Promise<Response>) | null = null;

export function handle(request: Request): Promise<Response> {
    cached ??= withRouteParam(createRemoteHandler());
    return cached(request);
}
