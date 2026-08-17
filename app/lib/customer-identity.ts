const LETTERS = "ABCDEFGHJKMNPQRSTUVWXYZ";
const DIGITS = "23456789";

function randomIndex(length: number): number {
  const values = new Uint32Array(1);
  crypto.getRandomValues(values);
  return values[0] % length;
}

export function generateCustomerIdentityCode(): string {
  const characters = [
    LETTERS[randomIndex(LETTERS.length)],
    LETTERS[randomIndex(LETTERS.length)],
    LETTERS[randomIndex(LETTERS.length)],
    DIGITS[randomIndex(DIGITS.length)],
    DIGITS[randomIndex(DIGITS.length)],
  ];
  for (let index = characters.length - 1; index > 0; index -= 1) {
    const target = randomIndex(index + 1);
    [characters[index], characters[target]] = [characters[target], characters[index]];
  }
  return characters.join("");
}

export function isValidCustomerIdentityCode(value: string): boolean {
  return /^(?=.*[A-Z])(?=.*[2-9])[A-KM-NP-Z2-9]{5}$/.test(value);
}
