/**
 * LivLiv Featured characters only. Personal/non-commercial use; the exact
 * credit and the player's canvas watermark are licence obligations.
 * See vendor/LICENSE-*.
 */
export const LIVLIV_CREDIT = "Characters: LivLiv (livliv.ai)";

export const LIVLIV_CHARACTERS = Object.freeze([
  Object.freeze({ id: "k01", name: "Sena" }),
  Object.freeze({ id: "k02", name: "Elio" }),
  Object.freeze({ id: "s01", name: "Hana" }),
  Object.freeze({ id: "v01", name: "Aster" }),
]);

export type LivLivCharacterId = (typeof LIVLIV_CHARACTERS)[number]["id"];

export const DEFAULT_LIVLIV_CHARACTER: LivLivCharacterId = "k01";

/** Whitelist: p01/p02/p03 and d03/d03ft are intentionally excluded. */
export function isLivLivCharacterId(id: string): id is LivLivCharacterId {
  return LIVLIV_CHARACTERS.some((character) => character.id === id);
}

/** Public directory, deliberately outside the /classroom App Router route. */
export function livlivCharacterPath(id: LivLivCharacterId): string {
  return `/classroom-livliv/characters/${id}.livliv`;
}

/** Resolves the public path to an absolute URL before handing it to the player. */
export function livlivCharacterUrl(id: string): string | null {
  if (!isLivLivCharacterId(id)) return null;
  const base =
    globalThis.document?.baseURI ??
    globalThis.location?.href ??
    "http://localhost/";
  return new URL(livlivCharacterPath(id), base).href;
}

/** Short, sanitized error code: never expose paths, messages or secrets. */
export function livlivErrorCode(error: unknown): string {
  const candidate = error as {
    code?: unknown;
    name?: unknown;
    message?: unknown;
  } | null;
  const raw = String(candidate?.code ?? candidate?.name ?? candidate?.message ?? "unknown");
  return raw.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40) || "unknown";
}
