/** Small argument-validation helpers shared by modules. */

/** Returns an error message when exactly one of a lat/lon pair is given. */
export function pairError(
  lat: number | undefined,
  lon: number | undefined,
  latName: string,
  lonName: string,
): string | undefined {
  if ((lat === undefined) !== (lon === undefined)) {
    return `Pass both ${latName} and ${lonName} (or neither); got only ${lat === undefined ? lonName : latName}.`;
  }
  return undefined;
}
