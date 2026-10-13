/**
 * Product codes made by the app (C71): three letters from the product's name, a dash and a
 * three-digit number counted within those letters — "Tomato Seed Sachet" → TOM-001, the next
 * product that starts "Tom…" → TOM-002.
 */

/** The three letters a product's code starts with: the first three letters of its name, in capitals. */
export function productCodeLetters(name: string): string {
  // Accented letters count as their plain letter; anything that is not a letter is skipped.
  const letters = name
    .normalize("NFD")
    .replace(/[^A-Za-z]/g, "")
    .toUpperCase();
  // A name with fewer than three letters ("5L", "A1") is filled out with X.
  return (letters + "XXX").slice(0, 3);
}

/** The next free code for those letters, given the codes the business already uses. */
export function nextProductCode(name: string, codesInUse: (string | null)[]): string {
  const letters = productCodeLetters(name);
  const numbered = new RegExp(`^${letters}-(\\d+)$`, "i");
  let highest = 0;
  for (const code of codesInUse) {
    const match = code ? numbered.exec(code.trim()) : null;
    if (match) highest = Math.max(highest, Number.parseInt(match[1], 10));
  }
  return `${letters}-${String(highest + 1).padStart(3, "0")}`;
}
