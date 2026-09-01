/**
 * A non-2xx from one of our own functions.
 *
 * It lives in its own module rather than beside the hooks that throw it because the
 * image pass needs to recognise a 401 without dragging TanStack Query — and a
 * dependency cycle — into a file that only talks to IndexedDB and `fetch`.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly detail?: string,
  ) {
    super(detail ?? `Request failed with ${status}`);
    this.name = 'ApiError';
  }
}
