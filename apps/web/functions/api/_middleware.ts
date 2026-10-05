import { guardApiRequest } from "../../server/http";

// Runs for /api/* only. A root middleware would route every static file through Functions.
export const onRequest: PagesFunction = async ({ request, next }) => guardApiRequest(request) ?? next();
