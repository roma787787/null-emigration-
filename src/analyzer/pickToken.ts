/**
 * When a deployer owns several tracked tokens, attribute the new contract to
 * the one it actually references — its address appears in the creation
 * input (constructor args or inlined immutables) — rather than whichever
 * matched first. Falls back to the first candidate when none is referenced.
 */
export function pickReferencedToken<T extends { address: string }>(tokens: T[], creationInputs: string[]): T | null {
  const haystacks = creationInputs.map((input) => input.toLowerCase());
  const referenced = tokens.find((token) => {
    const needle = token.address.toLowerCase().replace(/^0x/, "");
    return haystacks.some((h) => h.includes(needle));
  });
  return referenced ?? tokens[0] ?? null;
}
