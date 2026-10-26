// Función única de Vercel: delega en el build TypeScript (npm run build → build/).
import { handle } from "../build/remote/vercel.js";

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
export const OPTIONS = handle;
